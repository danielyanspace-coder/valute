import { describe, expect, it } from 'vitest';
import { AmlService } from '../aml/amlService.js';
import { openDatabase } from '../db/database.js';
import type { TronChain } from '../deposits/tronClient.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo } from '../users/userRepo.js';
import { UsdtPayoutService } from '../usdtPayouts/usdtPayoutService.js';
import { PremiumService, isPremium, mskMonth } from './premiumService.js';

const USDT = 1_000_000;
const DAY = 86_400_000;
const TO = 'TYr4DLeAY4S7g9FkQQGvo8DmyPDvzb8HWq';

const chain: TronChain = {
  incomingUsdt: async () => [],
  verifyUsdtTo: async () => ({ state: 'unconfirmed' }),
  balance: async () => ({ usdtMicro: 0, trxSun: 0 }),
} as unknown as TronChain;

function setup() {
  const db = openDatabase(':memory:');
  const clock = { now: Date.UTC(2026, 9, 10, 12) };
  const now = () => clock.now;
  const users = new UserRepo(db);
  const ann = users.upsertFromTelegram({ id: 1, first_name: 'Ann' });
  const bob = users.upsertFromTelegram({ id: 2, first_name: 'Bob' });
  const ledger = new Ledger(db, now);
  for (const u of [ann, bob]) ledger.post([{ userId: u.id, bucket: 'available', amountMicro: 200 * USDT, kind: 'deposit' }]);
  const sent: string[] = [];
  const notifications = new NotificationService(db, { send: async (_id, text) => void sent.push(text) }, () => {}, now);
  const svc = new PremiumService(db, ledger, users, notifications, undefined, now);
  const bal = (id: number) => ledger.balances(id).availableMicro;
  /** A finished USDT withdrawal, the simplest turnover row. */
  const turnover = (userId: number, amountMicro: number, at: number) =>
    db
      .prepare(
        `INSERT INTO usdt_payouts (user_id, request_id, address, amount_micro, fee_micro, status, balance_before_micro, created_at, finished_at)
         VALUES (?, ?, ?, ?, 0, 'sent', 0, ?, ?)`,
      )
      .run(userId, `t-${at}-${amountMicro}`, TO, amountMicro, at, at);
  return { db, clock, users, ann, bob, ledger, svc, bal, sent, turnover };
}

describe('PremiumService', () => {
  it('charges the balance once per request and stacks periods', () => {
    const t = setup();
    const s1 = t.svc.buy(t.ann, { plan: 'month', requestId: 'a' });
    expect(t.bal(t.ann.id)).toBe(200 * USDT - 14_990_000);
    expect(s1.until).toBe(t.clock.now + 30 * DAY);
    // Same request again: nothing more is charged.
    t.svc.buy(t.ann, { plan: 'month', requestId: 'a' });
    expect(t.bal(t.ann.id)).toBe(200 * USDT - 14_990_000);
    // Buying again extends from the current end.
    const s2 = t.svc.buy(t.ann, { plan: 'quarter', requestId: 'b' });
    expect(s2.until).toBe(t.clock.now + 120 * DAY);
    expect(isPremium(t.db, t.ann.id, t.clock.now + 100 * DAY)).toBe(true);
    expect(isPremium(t.db, t.ann.id, t.clock.now + 121 * DAY)).toBe(false);
    expect(t.sent.at(-1)).toContain('IX Black активен');
  });

  it('refuses without enough balance', () => {
    const t = setup();
    t.ledger.post([{ userId: t.bob.id, bucket: 'available', amountMicro: -195 * USDT, kind: 'manual_adjustment' }]);
    expect(() => t.svc.buy(t.bob, { plan: 'month', requestId: 'x' })).toThrow(/Недостаточно средств/);
    expect(t.svc.until(t.bob.id)).toBeNull();
  });

  it('puts IX Black requests first in the admin queue', async () => {
    const t = setup();
    const aml = new AmlService([]);
    const payouts = new UsdtPayoutService(t.db, t.ledger, t.users, new NotificationService(t.db, null), aml, chain, { feeMicro: USDT, minMicro: USDT }, undefined, () => t.clock.now);
    await payouts.create(t.bob, { address: TO, amount: '10', requestId: 'b1', acceptedTerms: true });
    t.svc.buy(t.ann, { plan: 'month', requestId: 'p' });
    await payouts.create(t.ann, { address: TO, amount: '10', requestId: 'a1', acceptedTerms: true });
    const list = payouts.adminList('new');
    expect(list.map((p) => [p.user.id, p.priority])).toEqual([
      [t.ann.id, true],
      [t.bob.id, false],
    ]);
  });

  it('pays 0.2% of last month turnover inside paid days, once', () => {
    const t = setup();
    const oct = mskMonth(t.clock.now);
    t.turnover(t.ann.id, 500 * USDT, t.clock.now - DAY); // before the status: not counted
    t.svc.buy(t.ann, { plan: 'month', requestId: 'p' });
    t.turnover(t.ann.id, 1000 * USDT, t.clock.now + DAY);
    t.turnover(t.bob.id, 1000 * USDT, t.clock.now + DAY); // no status
    expect(t.svc.status(t.ann.id).monthTurnoverMicro).toBe(1000 * USDT);

    const before = t.bal(t.ann.id);
    t.clock.now = oct.end + 3_600_000; // 1 November, 01:00 Moscow
    t.svc.payCashback();
    t.svc.payCashback();
    expect(t.bal(t.ann.id)).toBe(before + 2 * USDT);
    expect(t.bal(t.bob.id)).toBe(200 * USDT);
    expect(t.svc.status(t.ann.id).cashback).toEqual([{ month: oct.key, turnoverMicro: 1000 * USDT, amountMicro: 2 * USDT }]);
    expect(t.sent.at(-1)).toContain('+2 USDT');
  });

  it('reminds three days before the end and when it ends, unless extended', () => {
    const t = setup();
    t.svc.buy(t.ann, { plan: 'month', requestId: 'p' });
    const start = t.clock.now;
    t.clock.now = start + 28 * DAY;
    t.svc.remind();
    t.svc.remind();
    expect(t.sent.filter((s) => s.includes('действует до'))).toHaveLength(1);
    t.clock.now = start + 30 * DAY + 1;
    t.svc.remind();
    expect(t.sent.at(-1)).toContain('закончился');
  });
});
