import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateOrderRequest } from '../../../shared/api.js';
import type { FineInfo } from '../../../shared/services.js';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo, type UserRow } from '../users/userRepo.js';
import { AuditLog } from '../audit/auditLog.js';
import { WithdrawalService } from '../withdrawals/withdrawalService.js';
import { NoFineLookup, type FineLookup } from './fineLookup.js';
import { OrderService } from './orderService.js';

const U = 1_000_000;
const RAPIRA = 90; // service rate with 10% off: 100 ₽ per USDT
let users: UserRepo;
let ledger: Ledger;
let notifications: NotificationService;
let withdrawals: WithdrawalService;
let user: UserRow;
let bot: string[];
let db: ReturnType<typeof openDatabase>;

const make = (fines: FineLookup = new NoFineLookup()) =>
  new OrderService(db, users, ledger, notifications, withdrawals, fines, 10);
const req = (over: Partial<CreateOrderRequest>): CreateOrderRequest => ({
  kind: 'parking', requestId: Math.random().toString(36), acceptedTerms: true, ...over,
});

beforeEach(() => {
  db = openDatabase(':memory:');
  bot = [];
  users = new UserRepo(db);
  ledger = new Ledger(db);
  notifications = new NotificationService(db, { send: async (_t, text) => void bot.push(text) });
  withdrawals = new WithdrawalService(db, users, ledger, notifications, new AuditLog(db));
  user = users.upsertFromTelegram({ id: 1, first_name: 'Fox', username: 'fox' });
  withdrawals.adjustBalance(user.id, 100 * U, 'test');
});

describe('pricing', () => {
  it('charges 10% less USDT than the Rapira price and reports the benefit', async () => {
    const svc = make();
    expect(svc.rateFor(RAPIRA)).toBe(100);
    const o = await svc.create(user, req({ kind: 'parking', phone: '+79123456789', amountRub: 1000 }), RAPIRA);
    expect(o.amount_micro).toBe(10 * U); // 1000 ₽ / 100
    expect(svc.toUserDto(o)).toMatchObject({ benefitRub: 100, target: '+7 912 345-67-89', status: 'pending' });
    expect(ledger.balances(user.id)).toEqual({ availableMicro: 90 * U, frozenMicro: 10 * U });
  });

  it('steam: USDT in, whole rubles out, within 500-15 000 ₽', async () => {
    const svc = make();
    const o = await svc.create(user, req({ kind: 'steam', steamLogin: 'gaben_fan', amountUsdt: '7.5' }), RAPIRA);
    expect(o).toMatchObject({ amount_micro: 7_500_000, amount_rub: 750, steam_login: 'gaben_fan' });
    await expect(svc.create(user, req({ kind: 'steam', steamLogin: 'gaben_fan', amountUsdt: '4' }), RAPIRA)).rejects.toThrow(/Минимум 500/);
    await expect(svc.create(user, req({ kind: 'steam', steamLogin: 'Гейб', amountUsdt: '10' }), RAPIRA)).rejects.toThrow(/латинские/);
  });
});

describe('fines', () => {
  it('without a provider takes the amount typed by the user and marks it', async () => {
    const svc = make();
    const o = await svc.create(user, req({ kind: 'fine', uin: '18810177230000123456', amountRub: 500 }), RAPIRA);
    expect(o).toMatchObject({ amount_rub: 500, amount_source: 'user', uin: '18810177230000123456' });
    await expect(svc.create(user, req({ kind: 'fine', uin: '123', amountRub: 500 }), RAPIRA)).rejects.toThrow(/20 или 25/);
  });

  it('with a provider charges the discounted amount it reports, ignoring the client', async () => {
    const fine: FineInfo = {
      uin: '18810177230000123456', amountRub: 1000, discountedAmountRub: 500, discountUntil: 1, issuedAt: 1,
      article: '12.9.2', description: 'Превышение скорости',
    };
    const svc = make({ available: true, lookup: async (uin) => (uin === fine.uin ? fine : null) });
    const o = await svc.create(user, req({ kind: 'fine', uin: fine.uin, amountRub: 1 }), RAPIRA);
    expect(o).toMatchObject({ amount_rub: 500, amount_micro: 5 * U, amount_source: 'provider' });
    await expect(svc.create(user, req({ kind: 'fine', uin: '18810177230000999999' }), RAPIRA)).rejects.toThrow(/не найден/);
  });
});

describe('admin statuses', () => {
  it('clarify keeps USDT frozen; paid writes them off; reject refunds', async () => {
    const svc = make();
    const a = await svc.create(user, req({ phone: '+79123456789', amountRub: 1000 }), RAPIRA);
    expect(svc.clarify(a.id, 'Проверьте номер телефона').status).toBe('clarify');
    expect(svc.toUserDto(svc.row(a.id)!).clarifyMessage).toBe('Проверьте номер телефона');
    expect(ledger.balances(user.id).frozenMicro).toBe(10 * U);
    expect(svc.markPaid(a.id).status).toBe('paid');
    expect(ledger.balances(user.id)).toEqual({ availableMicro: 90 * U, frozenMicro: 0 });
    expect(() => svc.reject(a.id, 'x')).toThrow(/недоступно/);

    const b = await svc.create(user, req({ phone: '+79123456789', amountRub: 500 }), RAPIRA);
    expect(() => svc.reject(b.id, ' ')).toThrow(/причину/);
    svc.reject(b.id, 'Счёт не найден');
    expect(ledger.balances(user.id)).toEqual({ availableMicro: 90 * U, frozenMicro: 0 });
    expect(notifications.unseen(user.id).map((n) => n.type)).toEqual(['order_clarify', 'order_paid', 'order_rejected']);
    expect(bot[1].replace(/\s/g, ' ')).toBe('Парковки России: заявка #1 на 1 000 ₽ оплачена.');
    expect(svc.adminGet(a.id).events.map((e) => e.type)).toEqual(['created', 'clarify', 'paid']);
    expect(svc.counts()).toEqual({ pending: 0, clarify: 0, paid: 1, rejected: 1 });
  });

  it('is idempotent and refuses overdrafts and locked wallets', async () => {
    const svc = make();
    const a = await svc.create(user, req({ requestId: 'same', phone: '+79123456789', amountRub: 1000 }), RAPIRA);
    const b = await svc.create(user, req({ requestId: 'same', phone: '+79123456789', amountRub: 1000 }), RAPIRA);
    expect(b.id).toBe(a.id);
    await expect(svc.create(user, req({ phone: '+79123456789', amountRub: 15000 }), RAPIRA)).rejects.toThrow(/Недостаточно/);
    await expect(svc.create(user, req({ phone: '+79123456789', amountRub: 1000 }), null)).rejects.toThrow(/Курс/);
  });
});
