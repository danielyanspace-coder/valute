import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateWithdrawalRequest } from '../../../shared/api.js';
import { CONFIRM_WINDOW_MS } from '../../../shared/payout.js';
import { openDatabase, type Db } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo, type UserRow } from '../users/userRepo.js';
import { WithdrawalService } from './withdrawalService.js';

const QUOTE = { rate: 82, exchangeRate: 78.1 };
const VALID_CARD = '2200000000000004'; // МИР test number, passes Luhn

let now: number;
let db: Db;
let users: UserRepo;
let ledger: Ledger;
let notifications: NotificationService;
let svc: WithdrawalService;
let user: UserRow;
let sent: { tid: number; text: string }[];

const sbp = (over: Partial<CreateWithdrawalRequest> = {}): CreateWithdrawalRequest => ({
  method: 'sbp', amountRub: 8200, phone: '8 (912) 345-67-89', bankId: '100000000111',
  requestId: Math.random().toString(36), acceptedTerms: true, ...over,
});

beforeEach(() => {
  now = 1_000_000;
  sent = [];
  db = openDatabase(':memory:');
  users = new UserRepo(db, () => now);
  ledger = new Ledger(db, () => now);
  notifications = new NotificationService(db, { send: async (tid, text) => void sent.push({ tid, text }) }, undefined, () => now);
  svc = new WithdrawalService(db, users, ledger, notifications, () => now);
  user = users.upsertFromTelegram({ id: 777, first_name: 'Fox', username: 'darkfox_ix' });
  svc.adjustBalance(user.id, 150_000_000, 'test deposit'); // 150 USDT
});

describe('create', () => {
  it('freezes the exact USDT amount at the sell rate', () => {
    const w = svc.create(user, sbp(), QUOTE, { ip: '1.2.3.4' });
    expect(w.status).toBe('pending');
    expect(w.amount_micro).toBe(100_000_000); // 8200 / 82 = 100 USDT
    expect(w.phone).toBe('79123456789');
    expect(w.bank_name).toBe('Сбербанк');
    expect(w.balance_before_micro).toBe(150_000_000);
    expect(ledger.balances(user.id)).toEqual({ availableMicro: 50_000_000, frozenMicro: 100_000_000 });
  });

  it('is idempotent per requestId', () => {
    const a = svc.create(user, sbp({ requestId: 'r1' }), QUOTE);
    const b = svc.create(user, sbp({ requestId: 'r1' }), QUOTE);
    expect(b.id).toBe(a.id);
    expect(ledger.balances(user.id).frozenMicro).toBe(100_000_000);
  });

  it('validates amount, phone, bank, card and balance', () => {
    expect(() => svc.create(user, sbp({ amountRub: 400 }), QUOTE)).toThrow(/Минимальная/);
    expect(() => svc.create(user, sbp({ amountRub: 1250 }), QUOTE)).toThrow(/кратна/);
    expect(() => svc.create(user, sbp({ phone: '+7 495 123-45-67' }), QUOTE)).toThrow(/мобильный/);
    expect(() => svc.create(user, sbp({ bankId: 'nope' }), QUOTE)).toThrow(/банк/);
    expect(() => svc.create(user, sbp({ method: 'card', cardNumber: '2200000000000005' }), QUOTE)).toThrow(/ошибка/);
    expect(() => svc.create(user, sbp({ amountRub: 20000 }), QUOTE)).toThrow(/Недостаточно/);
    expect(() => svc.create(user, sbp(), null)).toThrow(/Курс/);
    const card = svc.create(user, sbp({ method: 'card', cardNumber: '2200 0000 0000 0004', amountRub: 500 }), QUOTE);
    expect(card.card_number).toBe(VALID_CARD);
    expect(card.card_brand).toBe('mir');
  });

  it('refuses blocked users', () => {
    users.setBlocked(user.id, true);
    expect(() => svc.create(users.get(user.id)!, sbp(), QUOTE)).toThrow(/недоступен/);
  });
});

describe('lifecycle', () => {
  it('pending → sent → confirmed by user writes the USDT off', () => {
    const w = svc.create(user, sbp(), QUOTE);
    const s = svc.markSent(w.id);
    expect(s.status).toBe('sent');
    expect(s.confirm_deadline).toBe(now + CONFIRM_WINDOW_MS);
    expect(notifications.unseen(user.id).map((n) => n.type)).toEqual(['confirm_receipt']);
    expect(sent[0]).toMatchObject({ tid: 777 });

    const c = svc.confirmByUser(user.id, w.id);
    expect(c).toMatchObject({ status: 'completed', confirmed_by: 'user' });
    expect(ledger.balances(user.id)).toEqual({ availableMicro: 50_000_000, frozenMicro: 0 });
    expect(() => svc.confirmByUser(user.id, w.id)).toThrow(/недоступно/);
  });

  it('auto-confirms after 10 minutes and counts a missed confirmation', () => {
    const w = svc.create(user, sbp(), QUOTE);
    svc.markSent(w.id);
    now += CONFIRM_WINDOW_MS - 1;
    expect(svc.autoConfirmDue()).toBe(0);
    now += 1;
    expect(svc.autoConfirmDue()).toBe(1);
    expect(svc.getForUser(user.id, w.id)).toMatchObject({ status: 'completed', confirmed_by: 'auto' });
    expect(users.get(user.id)!.missed_confirmations).toBe(1);
  });

  it('dispute stops the timer; admin can resend or confirm manually', () => {
    const w = svc.create(user, sbp(), QUOTE);
    svc.markSent(w.id);
    expect(svc.disputeByUser(user.id, w.id).status).toBe('disputed');
    now += CONFIRM_WINDOW_MS * 2;
    expect(svc.autoConfirmDue()).toBe(0);

    expect(svc.markSent(w.id).status).toBe('sent'); // resend restarts the window
    svc.disputeByUser(user.id, w.id);
    expect(svc.confirmByAdmin(w.id)).toMatchObject({ status: 'completed', confirmed_by: 'admin' });

    const d = svc.adminGet(w.id);
    expect(d.events.map((e) => e.type)).toEqual(['created', 'marked_sent', 'disputed', 'marked_sent', 'disputed', 'confirmed']);
    expect(d.events[2].data).toEqual({ username: 'darkfox_ix' });
    expect(d.userDetails.stats).toMatchObject({ withdrawalsCompleted: 1, disputes: 1, withdrawnRub: 8200 });
  });

  it('reject returns the frozen USDT and requires a reason', () => {
    const w = svc.create(user, sbp(), QUOTE);
    expect(() => svc.reject(w.id, ' ')).toThrow(/причину/);
    expect(svc.reject(w.id, 'Неверный номер').status).toBe('rejected');
    expect(ledger.balances(user.id)).toEqual({ availableMicro: 150_000_000, frozenMicro: 0 });
    expect(notifications.unseen(user.id).map((n) => n.type)).toEqual(['withdrawal_rejected']);
  });

  it('users cannot touch other users withdrawals; contact request notifies', () => {
    const w = svc.create(user, sbp(), QUOTE);
    const other = users.upsertFromTelegram({ id: 888, first_name: 'Other' });
    expect(() => svc.confirmByUser(other.id, w.id)).toThrow(/не найдена/);
    svc.requestContact(w.id);
    expect(notifications.unseen(user.id).map((n) => n.type)).toEqual(['contact_support']);
    expect(svc.adminGet(w.id).contactRequestedAt).toBe(now);
  });

  it('flags other accounts that used the same card', () => {
    const other = users.upsertFromTelegram({ id: 888, first_name: 'Other' });
    svc.adjustBalance(other.id, 50_000_000, 'test');
    svc.create(other, sbp({ method: 'card', cardNumber: VALID_CARD, amountRub: 500 }), QUOTE);
    const w = svc.create(user, sbp({ method: 'card', cardNumber: VALID_CARD, amountRub: 500 }), QUOTE);
    expect(svc.adminGet(w.id).sameDestinationUsers).toEqual([{ id: other.id, username: null, firstName: 'Other', withdrawals: 1 }]);
  });
});

describe('contact lock', () => {
  it('locks money operations until the deal is finished', () => {
    const w = svc.create(user, sbp(), QUOTE);
    expect(svc.contactLock(user.id)).toBeNull();
    svc.requestContact(w.id);
    expect(svc.contactLock(user.id)).toEqual({ withdrawalId: w.id, amountRub: 8200 });
    expect(() => svc.create(user, sbp({ amountRub: 500 }), QUOTE)).toThrow(/недоступен/);
    svc.reject(w.id, 'Не удалось связаться');
    expect(svc.contactLock(user.id)).toBeNull();
    expect(() => svc.requestContact(w.id)).toThrow(/завершена/);
  });
});
