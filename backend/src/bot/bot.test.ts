import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { TransferService } from '../transfers/transferService.js';
import { UserRepo } from '../users/userRepo.js';
import { AuditLog } from '../audit/auditLog.js';
import { WithdrawalService } from '../withdrawals/withdrawalService.js';
import { WalletBot, type TelegramApi } from './bot.js';

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserRepo(db);
  const ledger = new Ledger(db);
  const notifications = new NotificationService(db, null);
  const withdrawals = new WithdrawalService(db, users, ledger, notifications, new AuditLog(db));
  const transfers = new TransferService(db, users, ledger, notifications, withdrawals, () => 'ix_bot');
  const calls: { method: string; params: any }[] = [];
  const api = { call: async (method: string, params: any = {}) => { calls.push({ method, params }); return method === 'getMe' ? { username: 'ix_bot' } : true; } } as unknown as TelegramApi;
  const bot = new WalletBot(api, { users, ledger, transfers, withdrawals, publicUrl: 'https://wallet.example', supportUsername: 'ix_support', log: { info() {}, error() {} } });
  bot.username = 'ix_bot';
  return { users, ledger, withdrawals, bot, calls, database: db };
}

const alice = { id: 100, first_name: 'Alice', username: 'alice_ix' };
const bob = { id: 200, first_name: 'Bob' };

describe('WalletBot', () => {
  it('inline check → sent → claimed via /start, with messages and edits', async () => {
    const { users, ledger, withdrawals, bot, calls } = setup();
    const a = users.upsertFromTelegram(alice);
    withdrawals.adjustBalance(a.id, 20_000_000, 'test');

    await bot.handle({ update_id: 1, inline_query: { id: 'q1', from: alice, query: '5 на кофе' } });
    const answer = calls.find((c) => c.method === 'answerInlineQuery')!.params;
    const result = answer.results[0];
    expect(result).toMatchObject({
      type: 'photo',
      photo_url: 'https://wallet.example/api/checks/image/5.jpg',
      caption: 'Чек на 5 USDT ($5.00).\n«на кофе»',
    });
    expect(result.reply_markup.inline_keyboard[0][0]).toEqual({ text: 'Получить 5 USDT', url: `https://t.me/ix_bot?start=c_${result.id}` });
    expect(ledger.balances(a.id).frozenMicro).toBe(0); // nothing reserved until sent

    await bot.handle({ update_id: 2, chosen_inline_result: { result_id: result.id, from: alice, inline_message_id: 'im1' } });
    expect(ledger.balances(a.id)).toEqual({ availableMicro: 15_000_000, frozenMicro: 5_000_000 });

    await bot.handle({ update_id: 3, message: { chat: { id: 200, type: 'private' }, from: bob, text: `/start c_${result.id}` } });
    const b = users.upsertFromTelegram(bob);
    expect(ledger.balances(b.id).availableMicro).toBe(5_000_000);
    const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text);
    expect(sent[0]).toBe('Вы получили 5 USDT ($5.00) от @alice_ix.\nКомментарий: «на кофе»\nСредства уже на балансе.');
    expect(calls.find((c) => c.method === 'editMessageCaption')!.params).toMatchObject({ inline_message_id: 'im1', caption: 'Чек на 5 USDT активирован Bob.' });

    // second press
    await bot.handle({ update_id: 4, message: { chat: { id: 200, type: 'private' }, from: bob, text: `/start c_${result.id}` } });
    expect(calls.filter((c) => c.method === 'sendMessage').at(-1)!.params.text).toBe('Этот чек уже активирован');
  });

  it('answers with a hint when the balance is too low or the query is empty', async () => {
    const { bot, calls } = setup();
    await bot.handle({ update_id: 1, inline_query: { id: 'q', from: bob, query: '50' } });
    expect(calls[0].params).toMatchObject({ results: [], button: { text: 'Недостаточно средств · баланс 0 USDT' } });
    await bot.handle({ update_id: 2, inline_query: { id: 'q2', from: bob, query: '' } });
    expect(calls[1].params.button.text).toMatch(/Введите сумму/);
  });

  it('deal buttons: "received" asks to confirm the amount, then writes USDT off; locked users go to support', async () => {
    const { users, withdrawals, bot, calls, ledger, database } = setup();
    const a = users.upsertFromTelegram(alice);
    withdrawals.adjustBalance(a.id, 100_000_000, 'test');
    const w = withdrawals.create(a, { method: 'card', amountRub: 8000, cardNumber: '2200000000000004', requestId: 'r', acceptedTerms: true }, { rate: 80, exchangeRate: 76 });
    withdrawals.take(w.id);
    withdrawals.entered(w.id);
    const press = (data: string) =>
      bot.handle({ update_id: 9, callback_query: { id: 'cb', from: alice, data, message: { message_id: 55, chat: { id: 100 } } } });

    await press(`dr:${w.id}`); // too early: no reminder yet
    expect(calls.find((c) => c.method === 'answerCallbackQuery')!.params.show_alert).toBe(true);

    database.prepare('UPDATE withdrawals SET entered_at = entered_at - 130000 WHERE id = ?').run(w.id);
    calls.length = 0;
    await press(`dr:${w.id}`);
    expect(calls.find((c) => c.method === 'editMessageText')!.params.text).toBe(`Вам поступила сумма ${(8000).toLocaleString('ru-RU')} ₽ по заявке №${w.id}?`);
    await press(`dy:${w.id}`);
    expect(withdrawals.row(w.id)!.status).toBe('user_confirmed');
    expect(ledger.balances(a.id).frozenMicro).toBe(0);

    users.setSupportLock(a.id, true);
    calls.length = 0;
    await bot.handle({ update_id: 10, message: { chat: { id: 100, type: 'private' }, from: alice, text: '/start' } });
    expect(calls[0].params.text).toMatch(/Свяжитесь с поддержкой/);
    expect(calls[0].params.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/ix_support');
  });
});
