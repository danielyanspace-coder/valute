import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo, type UserRow } from '../users/userRepo.js';
import { AuditLog } from '../audit/auditLog.js';
import { WithdrawalService } from '../withdrawals/withdrawalService.js';
import { TransferService } from './transferService.js';

let users: UserRepo;
let ledger: Ledger;
let notifications: NotificationService;
let withdrawals: WithdrawalService;
let svc: TransferService;
let alice: UserRow;
let bob: UserRow;
let botMessages: { tid: number; text: string }[];
const U = 1_000_000;

beforeEach(() => {
  const db = openDatabase(':memory:');
  botMessages = [];
  users = new UserRepo(db);
  ledger = new Ledger(db);
  notifications = new NotificationService(db, { send: async (tid, text) => void botMessages.push({ tid, text }) });
  withdrawals = new WithdrawalService(db, users, ledger, notifications, new AuditLog(db));
  svc = new TransferService(db, users, ledger, notifications, withdrawals, () => 'ix_bot');
  alice = users.upsertFromTelegram({ id: 100, first_name: 'Alice', username: 'alice_ix' });
  bob = users.upsertFromTelegram({ id: 200, first_name: 'Bob', username: 'BobTheBuilder' });
  withdrawals.adjustBalance(alice.id, 50 * U, 'test');
});

describe('direct transfers', () => {
  it('moves USDT by username (case-insensitive) and notifies the recipient', () => {
    const t = svc.sendDirect(alice, { username: '@bobthebuilder', amount: '12,5', comment: 'за обед', requestId: 'r1' });
    expect(t.amount_micro).toBe(12_500_000);
    expect(ledger.balances(alice.id).availableMicro).toBe(37_500_000);
    expect(ledger.balances(bob.id).availableMicro).toBe(12_500_000);
    expect(notifications.unseen(bob.id).map((n) => n.type)).toEqual(['transfer_received']);
    expect(botMessages[0]).toEqual({ tid: 200, text: 'Вы получили 12.5 USDT от @alice_ix: «за обед».' });
    // idempotent
    svc.sendDirect(alice, { username: 'bobthebuilder', amount: '12.5', requestId: 'r1' });
    expect(ledger.balances(bob.id).availableMicro).toBe(12_500_000);
  });

  it('rejects unknown users, self, bad amounts and overdrafts', () => {
    expect(() => svc.sendDirect(alice, { username: 'nobody_here', amount: '1', requestId: 'a' })).toThrow(/не найден/);
    expect(() => svc.sendDirect(alice, { username: 'alice_ix', amount: '1', requestId: 'b' })).toThrow(/самому себе/);
    expect(() => svc.sendDirect(alice, { username: 'BobTheBuilder', amount: '1.234', requestId: 'c' })).toThrow(/двух знаков/);
    expect(() => svc.sendDirect(alice, { username: 'BobTheBuilder', amount: '0', requestId: 'd' })).toThrow(/Минимум/);
    expect(() => svc.sendDirect(alice, { username: 'BobTheBuilder', amount: '51', requestId: 'e' })).toThrow(/Недостаточно/);
  });
});

describe('checks', () => {
  it('reserves on create, pays the first claimer, notifies the creator', () => {
    const c = svc.createCheck(alice, { amount: '10', requestId: 'c1' });
    expect(ledger.balances(alice.id)).toEqual({ availableMicro: 40 * U, frozenMicro: 10 * U });
    expect(svc.checkDto(c).link).toBe(`https://t.me/ix_bot?start=c_${c.code}`);

    expect(() => svc.claim(c.code, alice)).toThrow(/ваш чек/);
    const { transfer } = svc.claim(c.code, bob);
    expect(transfer.kind).toBe('check');
    expect(ledger.balances(alice.id)).toEqual({ availableMicro: 40 * U, frozenMicro: 0 });
    expect(ledger.balances(bob.id).availableMicro).toBe(10 * U);
    expect(botMessages.map((m) => m.text)).toEqual(['Ваш чек на 10 USDT активировал @BobTheBuilder.']);

    const carol = users.upsertFromTelegram({ id: 300, first_name: 'Carol' });
    expect(() => svc.claim(c.code, carol)).toThrow(/уже активирован/);
  });

  it('cancel returns the reserve and blocks claiming', () => {
    const c = svc.createCheck(alice, { amount: '5' });
    svc.cancelCheck(alice.id, c.id);
    expect(ledger.balances(alice.id)).toEqual({ availableMicro: 50 * U, frozenMicro: 0 });
    expect(() => svc.claim(c.code, bob)).toThrow(/отменён/);
    expect(() => svc.cancelCheck(bob.id, c.id)).toThrow(/не найден/);
  });

  it('inline offers become checks when sent, or on first claim if the report was lost', () => {
    const code = svc.createOffer(alice, 3 * U, 'кофе');
    expect(ledger.balances(alice.id).frozenMicro).toBe(0);
    const c = svc.materializeOffer(code, 'inline-msg-1');
    expect(c).toMatchObject({ status: 'active', source: 'inline', inline_message_id: 'inline-msg-1', comment: 'кофе' });
    expect(svc.materializeOffer(code).id).toBe(c.id); // repeat is harmless

    const lost = svc.createOffer(alice, 2 * U, null);
    svc.claim(lost, bob);
    expect(ledger.balances(bob.id).availableMicro).toBe(2 * U);
    expect(ledger.balances(alice.id)).toEqual({ availableMicro: 45 * U, frozenMicro: 3 * U });
  });

  it('history merges transfers and checks; locked wallets cannot spend', () => {
    svc.sendDirect(alice, { username: 'BobTheBuilder', amount: '1', requestId: 'h1' });
    const c = svc.createCheck(alice, { amount: '2' });
    svc.claim(c.code, bob);
    expect(svc.history(alice.id).map((h) => h.type).sort()).toEqual(['check', 'transfer']);
    expect(svc.history(bob.id).map((h) => (h.type === 'transfer' ? h.transfer.kind : h.type)).sort()).toEqual(['check', 'direct']);

    withdrawals.adjustBalance(bob.id, 10 * U, 'test');
    users.setSupportLock(bob.id, true);
    expect(() => svc.sendDirect(bob, { username: 'alice_ix', amount: '1', requestId: 'x' })).toThrow(/недоступно/);
    expect(() => svc.createCheck(bob, { amount: '1' })).toThrow(/недоступно/);
  });
});
