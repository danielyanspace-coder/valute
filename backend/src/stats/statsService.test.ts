import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { UserRepo } from '../users/userRepo.js';
import { StatsService, dayStart } from './statsService.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const USDT = 1_000_000;

describe('StatsService', () => {
  it('counts paid deals per Moscow day and period', () => {
    // 2026-10-08 12:00 Moscow
    const now = Date.UTC(2026, 9, 8, 9, 0);
    const db = openDatabase(':memory:');
    const users = new UserRepo(db, () => now);
    const a = users.upsertFromTelegram({ id: 1, first_name: 'Ann', username: 'ann' });
    const b = users.upsertFromTelegram({ id: 2, first_name: 'Bob' });
    new Ledger(db, () => now).post([{ userId: a.id, bucket: 'available', amountMicro: 50 * USDT, kind: 'deposit' }]);
    let n = 0;
    const deal = (userId: number, rub: number, status: string, created: number, finished: number | null, extra: Record<string, number> = {}) => {
      db.prepare(
        `INSERT INTO withdrawals (user_id, request_id, method, amount_rub, amount_micro, rate, balance_before_micro, status, created_at, finished_at,
           entered_at, user_decided_at, user_decision)
         VALUES (?, ?, 'sbp', ?, ?, 90, 0, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, `r${n++}`, rub, Math.round((rub / 90) * USDT), status, created, finished, extra.entered ?? null, extra.decided ?? null, extra.decided ? 'received' : null);
    };
    const today = dayStart(now);
    expect(today).toBe(Date.UTC(2026, 9, 7, 21, 0)); // midnight in Moscow
    deal(a.id, 10_000, 'completed', now - 30 * MIN, now - 10 * MIN, { entered: now - 20 * MIN, decided: now - 16 * MIN });
    deal(b.id, 5_000, 'user_confirmed', now - 60 * MIN, now - 20 * MIN);
    deal(a.id, 20_000, 'completed', today - 2 * 60 * MIN, today - MIN); // yesterday
    deal(b.id, 7_000, 'cancelled', now - 5 * MIN, now - MIN);
    deal(a.id, 3_000, 'entered', now - 2 * MIN, null);

    const s = new StatsService(db, () => now).get();
    const [todayP, yesterday, week] = s.periods;
    expect(todayP).toMatchObject({ payoutRub: 15_000, payoutCount: 2, payoutUsers: 2, dealsCreated: 4, dealsCancelled: 1, avgDealMinutes: 30, avgResponseMinutes: 4 });
    expect(yesterday).toMatchObject({ payoutRub: 20_000, payoutCount: 1 });
    expect(week.payoutRub).toBe(35_000);
    expect(s.days).toHaveLength(14);
    expect(s.days.at(-1)).toMatchObject({ day: today, payoutRub: 15_000, payoutCount: 2 });
    expect(s.days.at(-2)?.payoutRub).toBe(20_000);
    expect(s.now).toMatchObject({ activeDeals: 2, dealsByStatus: { entered: 1, user_confirmed: 1 }, usersTotal: 2, availableMicro: 50 * USDT });
    expect(s.topUsers[0]).toMatchObject({ id: a.id, deals: 2, rub: 30_000 });
    expect(s.days.every((d, i, all) => i === 0 || d.day - all[i - 1].day === DAY)).toBe(true);
  });
});
