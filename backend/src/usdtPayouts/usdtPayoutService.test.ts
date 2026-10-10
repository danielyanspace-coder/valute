import { describe, expect, it } from 'vitest';
import { AmlService } from '../aml/amlService.js';
import type { AmlCheck, AmlSignal } from '../aml/types.js';
import { openDatabase } from '../db/database.js';
import type { TronChain, TxVerdict } from '../deposits/tronClient.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo } from '../users/userRepo.js';
import { UsdtPayoutService } from './usdtPayoutService.js';

const USDT = 1_000_000;
const TO = 'TYr4DLeAY4S7g9FkQQGvo8DmyPDvzb8HWq';
const POOL = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const TX = 'a'.repeat(64);

class FakeChain implements TronChain {
  verdicts = new Map<string, TxVerdict>();
  async incomingUsdt() {
    return [];
  }
  async verifyUsdtTo(txId: string): Promise<TxVerdict> {
    return this.verdicts.get(txId) ?? { state: 'unconfirmed' };
  }
  async balance() {
    return { usdtMicro: 0, trxSun: 0 };
  }
}

class FakeAml implements AmlCheck {
  readonly source = 'fake';
  flagged = new Set<string>();
  supports() {
    return true;
  }
  async check(_c: unknown, address: string): Promise<AmlSignal> {
    return { source: this.source, hit: this.flagged.has(address) };
  }
}

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserRepo(db);
  const user = users.upsertFromTelegram({ id: 42, first_name: 'Ann' });
  const ledger = new Ledger(db);
  ledger.post([{ userId: user.id, bucket: 'available', amountMicro: 100 * USDT, kind: 'deposit' }]);
  const sent: string[] = [];
  const notifications = new NotificationService(db, { send: async (_id, text) => void sent.push(text) });
  const chain = new FakeChain();
  const amlCheck = new FakeAml();
  db.prepare('INSERT INTO deposit_pool (address, created_at) VALUES (?, 0)').run(POOL);
  const svc = new UsdtPayoutService(db, ledger, users, notifications, new AmlService([amlCheck]), chain, { feeMicro: 5 * USDT, minMicro: 10 * USDT });
  const bal = () => ledger.balances(user.id);
  const req = (amount: string, extra = {}) => ({ address: TO, amount, requestId: `r-${amount}`, acceptedTerms: true as const, ...extra });
  return { db, user, svc, chain, amlCheck, bal, sent, req };
}

describe('UsdtPayoutService', () => {
  it('freezes amount plus fee, once per request id', async () => {
    const t = setup();
    const p = await t.svc.create(t.user, t.req('50'));
    expect(t.svc.toUserDto(p)).toMatchObject({ amountMicro: 50 * USDT, feeMicro: 5 * USDT, totalMicro: 55 * USDT, status: 'new' });
    expect(t.bal()).toEqual({ availableMicro: 45 * USDT, frozenMicro: 55 * USDT });
    await t.svc.create(t.user, t.req('50'));
    expect(t.bal().availableMicro).toBe(45 * USDT);
  });

  it('checks the address, the minimum and the balance with the fee', async () => {
    const t = setup();
    await expect(t.svc.create(t.user, t.req('50', { address: 'TYr4DLeAY4S7g9FkQQGvo8DmyPDvzb8HWQ' }))).rejects.toThrow(/не адрес TRON/);
    await expect(t.svc.create(t.user, t.req('50', { address: POOL }))).rejects.toThrow(/адрес пополнения/);
    await expect(t.svc.create(t.user, t.req('5'))).rejects.toThrow(/Минимум 10/);
    await expect(t.svc.create(t.user, t.req('96'))).rejects.toThrow(/95 USDT с учётом комиссии/);
    t.amlCheck.flagged.add(TO);
    await expect(t.svc.create(t.user, t.req('20'))).rejects.toThrow(/чёрном списке/);
    expect(t.bal().frozenMicro).toBe(0);
  });

  it('closes only with a hash that really sent the USDT', async () => {
    const t = setup();
    const p = await t.svc.create(t.user, t.req('50'));
    await expect(t.svc.markSent(p.id, 'zzz')).rejects.toThrow(/64 символа/);
    await expect(t.svc.markSent(p.id, TX)).rejects.toThrow(/не подтверждена/);
    t.chain.verdicts.set(TX, { state: 'confirmed', valueMicro: 40 * USDT, from: POOL, blockNumber: 1, blockTimestamp: 1 });
    await expect(t.svc.markSent(p.id, TX)).rejects.toThrow(/перевела 40 USDT/);
    t.chain.verdicts.set(TX, { state: 'confirmed', valueMicro: 50 * USDT, from: POOL, blockNumber: 1, blockTimestamp: 1 });
    const done = await t.svc.markSent(p.id, TX.toUpperCase());
    expect(done).toMatchObject({ status: 'sent', txId: TX });
    expect(t.bal()).toEqual({ availableMicro: 45 * USDT, frozenMicro: 0 });
    expect(t.sent[0]).toMatch(/Вывод 50 USDT отправлен/);

    const p2 = await t.svc.create(t.user, t.req('20'));
    await expect(t.svc.markSent(p2.id, TX)).rejects.toThrow(/уже указан в заявке/);
    expect(t.svc.toAdminDto(t.svc.get(p2.id)!).sameAddressBefore).toBe(1);
  });

  it('can be closed without the chain check when TronGrid is down', async () => {
    const t = setup();
    const p = await t.svc.create(t.user, t.req('30'));
    expect((await t.svc.markSent(p.id, TX, true)).adminNote).toBe('без проверки в сети');
  });

  it('rejection returns everything and tells the user why', async () => {
    const t = setup();
    const p = await t.svc.create(t.user, t.req('50'));
    expect(() => t.svc.reject(p.id, ' ')).toThrow(/причину/);
    t.svc.reject(p.id, 'адрес биржи не принимает TRC-20');
    expect(t.bal()).toEqual({ availableMicro: 100 * USDT, frozenMicro: 0 });
    expect(t.sent[0]).toMatch(/отклонён<\/b>\nПричина: адрес биржи/);
    expect(() => t.svc.reject(p.id, 'ещё раз')).toThrow(/уже обработана/);
    expect(t.svc.counts()).toEqual({ new: 0, sent: 0, rejected: 1 });
  });
});
