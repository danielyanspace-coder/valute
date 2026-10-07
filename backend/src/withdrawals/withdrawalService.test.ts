import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateWithdrawalRequest } from '../../../shared/api.js';
import { INACTIVE_AFTER_MS, REMINDER_INTERVAL_MS } from '../../../shared/deals.js';
import { AuditLog } from '../audit/auditLog.js';
import { openDatabase, type Db } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import type { InlineButton, Messenger, SendResult } from '../notifications/messenger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { ObligationService } from '../obligations/obligationService.js';
import { UserRepo, type UserRow } from '../users/userRepo.js';
import { WithdrawalService } from './withdrawalService.js';

const QUOTE = { rate: 80, exchangeRate: 76.19 };
const U = 1_000_000;
const VALID_CARD = '2200000000000004'; // МИР test number, passes Luhn

class FakeMessenger implements Messenger {
  sent: { chatId: number; text: string; buttons?: InlineButton[][] }[] = [];
  edits: { messageId: number; text?: string }[] = [];
  blocked = false;
  private nextId = 100;
  async send(chatId: number, text: string, opts: { buttons?: InlineButton[][] } = {}): Promise<SendResult> {
    if (this.blocked) return { ok: false, blocked: true, error: 'Forbidden: bot was blocked by the user' };
    this.sent.push({ chatId, text, buttons: opts.buttons });
    return { ok: true, messageId: this.nextId++ };
  }
  async sendPhoto(): Promise<SendResult> {
    return { ok: true, messageId: this.nextId++ };
  }
  async editText(_c: number, messageId: number, text: string): Promise<void> {
    this.edits.push({ messageId, text });
  }
  async editButtons(_c: number, messageId: number): Promise<void> {
    this.edits.push({ messageId });
  }
}

let now: number;
let db: Db;
let users: UserRepo;
let ledger: Ledger;
let notifications: NotificationService;
let audit: AuditLog;
let messenger: FakeMessenger;
let svc: WithdrawalService;
let obligations: ObligationService;
let user: UserRow;

const sbp = (over: Partial<CreateWithdrawalRequest> = {}): CreateWithdrawalRequest => ({
  method: 'sbp', amountRub: 8000, phone: '8 (912) 345-67-89', bankId: '100000000111',
  requestId: Math.random().toString(36), acceptedTerms: true, ...over,
});
const bal = () => ledger.balances(user.id);
const types = (id: number) => audit.forDeal(id).map((e) => e.type);

beforeEach(() => {
  now = 1_000_000_000;
  db = openDatabase(':memory:');
  users = new UserRepo(db, () => now);
  ledger = new Ledger(db, () => now);
  notifications = new NotificationService(db, null, undefined, () => now);
  audit = new AuditLog(db, () => now);
  messenger = new FakeMessenger();
  svc = new WithdrawalService(db, users, ledger, notifications, audit, messenger, 'https://wallet.example', () => now);
  obligations = new ObligationService(db, ledger, users, notifications, audit, 'ix_support', () => now);
  svc.obligations = obligations;
  user = users.upsertFromTelegram({ id: 777, first_name: 'Fox', username: 'darkfox_ix' });
  svc.adjustBalance(user.id, 150 * U, 'test deposit');
});

/** new → in_work → entered */
function enteredDeal(over: Partial<CreateWithdrawalRequest> = {}) {
  const w = svc.create(user, sbp(over), QUOTE);
  svc.take(w.id);
  svc.entered(w.id);
  return w;
}

describe('create', () => {
  it('freezes USDT at the wallet rate; amounts are multiples of 1000 ₽', () => {
    const w = svc.create(user, sbp(), QUOTE, { ip: '1.2.3.4' });
    expect(w.status).toBe('new');
    expect(w.amount_micro).toBe(100 * U); // 8000 / 80
    expect(bal()).toEqual({ availableMicro: 50 * U, frozenMicro: 100 * U });
    expect(() => svc.create(user, sbp({ amountRub: 500 }), QUOTE)).toThrow(/1000/);
    expect(() => svc.create(user, sbp({ amountRub: 1500 }), QUOTE)).toThrow(/кратна/);
    expect(() => svc.create(user, sbp({ amountRub: 20_000 }), QUOTE)).toThrow(/Недостаточно/);
    expect(() => svc.create(user, { ...sbp(), method: 'card', cardNumber: '4111111111111112' }, QUOTE)).toThrow(/ошибка/);
    expect(svc.create(user, { ...sbp({ amountRub: 1000 }), method: 'card', cardNumber: VALID_CARD }, QUOTE).card_number).toBe(VALID_CARD);
  });

  it('is idempotent per requestId', () => {
    const a = svc.create(user, sbp({ requestId: 'r1' }), QUOTE);
    expect(svc.create(user, sbp({ requestId: 'r1' }), QUOTE).id).toBe(a.id);
    expect(bal().frozenMicro).toBe(100 * U);
  });

  it('several deals freeze independently and never share the same USDT', () => {
    svc.create(user, sbp({ amountRub: 4000 }), QUOTE);
    svc.create(user, sbp({ amountRub: 4000 }), QUOTE);
    expect(bal()).toEqual({ availableMicro: 50 * U, frozenMicro: 100 * U });
    expect(() => svc.create(user, sbp({ amountRub: 5000 }), QUOTE)).toThrow(/Недостаточно/);
  });
});

describe('operator flow', () => {
  it('take cannot happen twice; entered records the time; ОТКЛЮЧИЛ clears the reminder', () => {
    const w = svc.create(user, sbp(), QUOTE);
    svc.take(w.id);
    expect(() => svc.take(w.id)).toThrow(/недоступно/);
    svc.entered(w.id);
    let item = svc.board().items[0];
    expect(item).toMatchObject({ status: 'entered', section: 'requisite', enteredAt: now, platformDeadline: now + 15 * 60_000 });
    svc.requisiteOff(w.id);
    item = svc.board().items[0];
    expect(item.section).toBe('awaiting');
    expect(types(w.id)).toEqual(['deal_created', 'deal_taken', 'deal_entered', 'requisite_off']);
  });
});

describe('reminders and inactivity', () => {
  it('sends 5 reminders every 2 minutes, then "inactive" at T+12 with USDT still frozen', async () => {
    const w = enteredDeal();
    const t0 = now;
    await svc.tick();
    expect(messenger.sent).toHaveLength(0);
    for (let n = 1; n <= 5; n++) {
      now = t0 + n * REMINDER_INTERVAL_MS;
      await svc.tick();
      await svc.tick(); // a second tick must not resend
      expect(messenger.sent).toHaveLength(n);
    }
    expect(messenger.sent[0].text).toMatch(/Деньги начали путь/);
    expect(messenger.sent[0].buttons!.flat().map((b) => b.text)).toEqual(['Подтвердить получение', 'Поступила другая сумма']);
    expect(messenger.sent[3].text).toMatch(/последним/);
    expect(messenger.sent[4].text).toMatch(/в течение 2 минут/);
    expect(messenger.sent[4].buttons!.flat().map((b) => b.text)).toEqual(['Оплата поступила', 'Оплата не поступила', 'Поступила другая сумма']);
    // Earlier reminders lose their buttons when the next one goes out.
    expect(messenger.edits.length).toBeGreaterThanOrEqual(4);

    now = t0 + INACTIVE_AFTER_MS - 1;
    await svc.tick();
    expect(svc.row(w.id)!.status).toBe('entered');
    now = t0 + INACTIVE_AFTER_MS;
    await svc.tick();
    expect(svc.row(w.id)!.status).toBe('inactive');
    expect(bal().frozenMicro).toBe(100 * U);
    expect(users.get(user.id)!.missed_confirmations).toBe(1);
    expect(svc.adminGet(w.id).reminders.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('after downtime sends only the latest reminder and keeps the original deadline', async () => {
    const w = enteredDeal();
    now += 7 * 60_000;
    await svc.tick();
    expect(messenger.sent).toHaveLength(1);
    expect(svc.row(w.id)!.reminders_sent).toBe(3);
    now += 5 * 60_000; // T+12
    await svc.tick();
    expect(svc.row(w.id)!.status).toBe('inactive');
  });

  it('sends no buttons to a user locked until they contact support', async () => {
    const w = enteredDeal();
    svc.setSupportLock(user.id, true, 'ix_support');
    now += REMINDER_INTERVAL_MS;
    await svc.tick();
    expect(messenger.sent).toHaveLength(0);
    expect(svc.adminGet(w.id).reminders[0]).toMatchObject({ n: 1, delivered: false, error: 'Заблокирован до связи с поддержкой' });
  });

  it('records undelivered reminders when the user blocked the bot', async () => {
    const w = enteredDeal();
    messenger.blocked = true;
    now += REMINDER_INTERVAL_MS;
    await svc.tick();
    expect(svc.adminGet(w.id).reminders[0]).toMatchObject({ n: 1, delivered: false, error: 'Пользователь заблокировал бота' });
  });
});

describe('user answers', () => {
  it('no buttons before the first reminder; "not received" only from the 5th', () => {
    const w = enteredDeal();
    expect(svc.toUserDto(svc.row(w.id)!).actions).toEqual([]);
    expect(() => svc.userReceived(user.id, w.id)).toThrow(/недоступно/);
    now += REMINDER_INTERVAL_MS;
    expect(svc.toUserDto(svc.row(w.id)!).actions).toEqual(['received', 'other_amount']);
    expect(() => svc.userNotReceived(user.id, w.id)).toThrow(/недоступно/);
    now += 4 * REMINDER_INTERVAL_MS;
    expect(svc.toUserDto(svc.row(w.id)!).actions).toEqual(['received', 'not_received', 'other_amount']);
  });

  it('"received" writes USDT off at once and is final for the user; the operator closes it', () => {
    const w = enteredDeal();
    now += REMINDER_INTERVAL_MS;
    svc.userReceived(user.id, w.id);
    expect(svc.row(w.id)).toMatchObject({ status: 'user_confirmed', debited_micro: 100 * U, final_rub: 8000 });
    expect(bal()).toEqual({ availableMicro: 50 * U, frozenMicro: 0 });
    expect(svc.toUserDto(svc.row(w.id)!).actions).toEqual([]);
    expect(() => svc.userNotReceived(user.id, w.id)).toThrow(/завершена/);
    expect(() => svc.cancel(w.id)).toThrow(/недоступно/); // those USDT are already written off
    svc.close(w.id, { externalId: ' P2P-4471 ' });
    expect(svc.row(w.id)).toMatchObject({ status: 'completed', resolution: 'closed', external_id: 'P2P-4471' });
    expect(svc.archive({ q: 'p2p-44' }).map((x) => x.id)).toEqual([w.id]);
  });

  it('the user may change their mind until the operator decides', async () => {
    const w = enteredDeal();
    now += 5 * REMINDER_INTERVAL_MS;
    svc.userNotReceived(user.id, w.id);
    expect(svc.row(w.id)!.status).toBe('not_received');
    svc.userOtherAmount(user.id, w.id, 7000);
    expect(svc.row(w.id)).toMatchObject({ status: 'mismatch', reported_rub: 7000 });
    svc.userReceived(user.id, w.id);
    expect(svc.row(w.id)!.status).toBe('user_confirmed');
    expect(bal().frozenMicro).toBe(0);
  });

  it('an inactive user can still answer', async () => {
    const w = enteredDeal();
    now += INACTIVE_AFTER_MS;
    await svc.tick();
    expect(svc.row(w.id)!.status).toBe('inactive');
    svc.userReceived(user.id, w.id);
    expect(svc.row(w.id)!.status).toBe('user_confirmed');
  });

  it('cannot touch someone else\'s deal', () => {
    const w = enteredDeal();
    const other = users.upsertFromTelegram({ id: 778, first_name: 'Other' });
    now += REMINDER_INTERVAL_MS;
    expect(() => svc.userReceived(other.id, w.id)).toThrow(/не найдена/);
  });
});

describe('operator decisions', () => {
  it('"not received": confirm writes off, cancel returns USDT', () => {
    const a = enteredDeal({ amountRub: 4000 });
    const b = enteredDeal({ amountRub: 4000 });
    now += 5 * REMINDER_INTERVAL_MS;
    svc.userNotReceived(user.id, a.id);
    svc.userNotReceived(user.id, b.id);
    svc.confirm(a.id, { externalId: 'X1' });
    expect(svc.row(a.id)).toMatchObject({ status: 'completed', resolution: 'confirmed_admin', debited_micro: 50 * U });
    svc.cancel(b.id, { reason: 'исполнитель вышел' });
    expect(svc.row(b.id)).toMatchObject({ status: 'cancelled', resolution: 'cancelled', refunded_micro: 50 * U });
    expect(bal()).toEqual({ availableMicro: 100 * U, frozenMicro: 0 });
    expect(() => svc.cancel(b.id)).toThrow(/недоступно/);
  });

  it('a lower reported amount: paid at the original rate, the excess unfrozen', () => {
    const w = enteredDeal(); // 8000 ₽ = 100 USDT at 80
    now += REMINDER_INTERVAL_MS;
    svc.userOtherAmount(user.id, w.id, 7200);
    expect(svc.adminGet(w.id).correction).toMatchObject({ correctedMicro: 90 * U, refundMicro: 10 * U, extraMicro: 0 });
    svc.acceptCorrection(w.id);
    expect(svc.row(w.id)).toMatchObject({ status: 'completed', resolution: 'correction', final_rub: 7200, debited_micro: 90 * U, refunded_micro: 10 * U });
    expect(bal()).toEqual({ availableMicro: 60 * U, frozenMicro: 0 });
  });

  it('a higher reported amount: extra from the balance, the rest as a shadow obligation', () => {
    const w = enteredDeal({ amountRub: 8000 });
    svc.adjustBalance(user.id, -45 * U, 'leave 5 USDT');
    now += REMINDER_INTERVAL_MS;
    svc.userOtherAmount(user.id, w.id, 9000); // 112.5 USDT: 100 frozen + 5 available + 7.5 short
    svc.acceptCorrection(w.id, { createObligation: true });
    expect(svc.row(w.id)).toMatchObject({ final_rub: 9000, debited_micro: 105 * U });
    expect(bal()).toEqual({ availableMicro: 0, frozenMicro: 0 });
    const [o] = obligations.list({ userId: user.id });
    expect(o).toMatchObject({ amountMicro: 7_500_000, repaidMicro: 0, status: 'active', withdrawalId: w.id });
  });

  it('"accept the original amount" ignores the report', () => {
    const w = enteredDeal();
    now += REMINDER_INTERVAL_MS;
    svc.userOtherAmount(user.id, w.id, 7000);
    svc.acceptOriginal(w.id);
    expect(svc.row(w.id)).toMatchObject({ resolution: 'original', final_rub: 8000, debited_micro: 100 * U });
  });

  it('reopen undoes a mistaken user confirmation', () => {
    const w = enteredDeal();
    now += REMINDER_INTERVAL_MS;
    svc.userReceived(user.id, w.id);
    svc.reopen(w.id);
    expect(svc.row(w.id)!.status).toBe('not_received');
    expect(bal().frozenMicro).toBe(100 * U);
    svc.cancel(w.id);
    expect(bal()).toEqual({ availableMicro: 150 * U, frozenMicro: 0 });
  });

  it('the journal has every step and notifications reach the user', () => {
    const w = enteredDeal();
    now += REMINDER_INTERVAL_MS;
    svc.userOtherAmount(user.id, w.id, 7200);
    svc.acceptCorrection(w.id, { externalId: 'EXT-1' });
    expect(types(w.id)).toEqual([
      'deal_created', 'deal_taken', 'deal_entered', 'user_other_amount', 'external_id_set', 'correction_accepted',
    ]);
    expect(notifications.unseen(user.id).map((n) => n.type)).toContain('deal_corrected');
  });
});

describe('support lock', () => {
  it('blocks the user\'s actions until lifted and tells them in the bot', () => {
    const w = enteredDeal();
    now += REMINDER_INTERVAL_MS;
    svc.setSupportLock(user.id, true, 'ix_support');
    expect(svc.contactLock(user.id)).toEqual({ since: now });
    expect(() => svc.userReceived(user.id, w.id)).toThrow(/поддержкой/);
    expect(() => svc.create(user, sbp(), QUOTE)).toThrow(/поддержкой/);
    expect(svc.toUserDto(svc.row(w.id)!).actions).toEqual([]);
    expect(notifications.unseen(user.id).at(-1)!.type).toBe('support_lock');
    svc.setSupportLock(user.id, false, 'ix_support');
    svc.userReceived(user.id, w.id);
    expect(audit.query({ types: 'support_lock,support_unlock' }).map((e) => e.type)).toEqual(['support_unlock', 'support_lock']);
  });
});

describe('shadow obligations', () => {
  it('held at once from the available balance, the rest from the next inflows', () => {
    svc.adjustBalance(user.id, -140 * U, 'leave 10'); // 10 USDT available
    const o = obligations.create({ userId: user.id, amountUsdt: 25, comment: 'переплата 2000 ₽' });
    expect(o).toMatchObject({ repaidMicro: 10 * U, status: 'active' });
    expect(bal().availableMicro).toBe(0);
    svc.adjustBalance(user.id, 8 * U, 'deposit');
    expect(obligations.get(o.id)).toMatchObject({ repaidMicro: 18 * U, status: 'active' });
    svc.adjustBalance(user.id, 20 * U, 'deposit');
    expect(obligations.get(o.id)).toMatchObject({ repaidMicro: 25 * U, status: 'repaid', repaidAt: now });
    expect(bal().availableMicro).toBe(13 * U);
    const holds = notifications.unseen(user.id).filter((n) => n.type === 'obligation_repaid');
    expect(holds.map((n) => n.amountMicro)).toEqual([10 * U, 8 * U, 7 * U]);
    expect(obligations.deductionsForUser(user.id)).toHaveLength(3);
    expect(obligations.get(o.id).repayments.map((r) => r.amountMicro)).toEqual([10 * U, 8 * U, 7 * U]);
  });

  it('frozen USDT of other deals are never touched; a cancelled deal refund is an inflow', () => {
    const w = svc.create(user, sbp(), QUOTE); // 100 frozen, 50 available
    svc.adjustBalance(user.id, -50 * U, 'spent'); // 0 available
    const o = obligations.create({ userId: user.id, amountUsdt: 30 });
    expect(o.repaidMicro).toBe(0);
    expect(bal()).toEqual({ availableMicro: 0, frozenMicro: 100 * U });
    svc.cancel(w.id); // 100 back to available → 30 held
    expect(obligations.get(o.id).status).toBe('repaid');
    expect(bal()).toEqual({ availableMicro: 70 * U, frozenMicro: 0 });
  });

  it('write-off stops future holds', () => {
    svc.adjustBalance(user.id, -150 * U, 'empty');
    const o = obligations.create({ userId: user.id, amountUsdt: 5 });
    obligations.writeOff(o.id, 'простили');
    svc.adjustBalance(user.id, 10 * U, 'deposit');
    expect(bal().availableMicro).toBe(10 * U);
    expect(() => obligations.writeOff(o.id, 'again')).toThrow(/закрыто/);
  });
});
