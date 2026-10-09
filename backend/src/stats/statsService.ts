import type { AdminStatsDto, AdminStatsPeriod } from '../../../shared/api.js';
import type { Db } from '../db/database.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Days are counted in Moscow time (UTC+3, no daylight saving). */
const MSK = 3 * HOUR;

export const dayStart = (t: number) => Math.floor((t + MSK) / DAY) * DAY - MSK;

/** A deal counts as paid out once the user confirmed it or the operator closed it. */
const PAID = `status IN ('completed', 'user_confirmed')`;
const PAID_AT = 'COALESCE(finished_at, user_confirmed_at, user_decided_at)';

/** Turnover and workload numbers for the admin panel. Read-only. */
export class StatsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private one<T>(sql: string, ...args: (number | string)[]): T {
    return this.db.prepare(sql).get(...args) as T;
  }

  private period(label: string, from: number, to: number): AdminStatsPeriod {
    const w = this.one<{ n: number; rub: number; micro: number; avg_min: number | null }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(final_rub, amount_rub)), 0) AS rub,
              COALESCE(SUM(COALESCE(debited_micro, amount_micro)), 0) AS micro,
              AVG((${PAID_AT} - created_at) / 60000.0) AS avg_min
       FROM withdrawals WHERE ${PAID} AND ${PAID_AT} >= ? AND ${PAID_AT} < ?`,
      from, to,
    );
    const created = this.one<{ n: number; cancelled: number }>(
      `SELECT COUNT(*) AS n, SUM(status = 'cancelled') AS cancelled FROM withdrawals WHERE created_at >= ? AND created_at < ?`,
      from, to,
    );
    const response = this.one<{ avg_min: number | null }>(
      `SELECT AVG((user_decided_at - entered_at) / 60000.0) AS avg_min FROM withdrawals
       WHERE user_decision = 'received' AND entered_at IS NOT NULL AND user_decided_at >= ? AND user_decided_at < ?`,
      from, to,
    );
    const usdt = this.one<{ n: number; micro: number; fee: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro), 0) AS micro, COALESCE(SUM(fee_micro), 0) AS fee
       FROM usdt_payouts WHERE status = 'sent' AND finished_at >= ? AND finished_at < ?`,
      from, to,
    );
    const dep = this.one<{ n: number; micro: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro), 0) AS micro FROM deposits WHERE status = 'credited' AND finished_at >= ? AND finished_at < ?`,
      from, to,
    );
    const orders = this.one<{ n: number; rub: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_rub), 0) AS rub FROM service_orders WHERE status = 'paid' AND finished_at >= ? AND finished_at < ?`,
      from, to,
    );
    const tr = this.one<{ n: number; micro: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro), 0) AS micro FROM transfers WHERE created_at >= ? AND created_at < ?`,
      from, to,
    );
    const users = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?', from, to);
    const payers = this.one<{ n: number }>(
      `SELECT COUNT(DISTINCT user_id) AS n FROM withdrawals WHERE ${PAID} AND ${PAID_AT} >= ? AND ${PAID_AT} < ?`,
      from, to,
    );
    return {
      label,
      from,
      to,
      payoutRub: w.rub,
      payoutMicro: w.micro,
      payoutCount: w.n,
      payoutUsers: payers.n,
      avgDealMinutes: w.avg_min === null ? null : Math.round(w.avg_min * 10) / 10,
      avgResponseMinutes: response.avg_min === null ? null : Math.round(response.avg_min * 10) / 10,
      dealsCreated: created.n,
      dealsCancelled: created.cancelled ?? 0,
      usdtPayoutCount: usdt.n,
      usdtPayoutMicro: usdt.micro,
      usdtFeesMicro: usdt.fee,
      depositCount: dep.n,
      depositMicro: dep.micro,
      ordersCount: orders.n,
      ordersRub: orders.rub,
      transferCount: tr.n,
      transferMicro: tr.micro,
      newUsers: users.n,
    };
  }

  get(): AdminStatsDto {
    const now = this.now();
    const today = dayStart(now);
    const periods = [
      this.period('Сегодня', today, now + 1),
      this.period('Вчера', today - DAY, today),
      this.period('7 дней', today - 6 * DAY, now + 1),
      this.period('30 дней', today - 29 * DAY, now + 1),
    ];

    const days: AdminStatsDto['days'] = [];
    for (let i = 13; i >= 0; i--) {
      const from = today - i * DAY;
      const p = this.one<{ rub: number; n: number }>(
        `SELECT COALESCE(SUM(COALESCE(final_rub, amount_rub)), 0) AS rub, COUNT(*) AS n FROM withdrawals WHERE ${PAID} AND ${PAID_AT} >= ? AND ${PAID_AT} < ?`,
        from, from + DAY,
      );
      days.push({ day: from, payoutRub: p.rub, payoutCount: p.n });
    }

    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM withdrawals WHERE status NOT IN ('completed', 'cancelled') GROUP BY status`)
      .all() as { status: string; n: number }[];
    const bal = this.one<{ available: number; frozen: number }>(
      `SELECT COALESCE(SUM(CASE WHEN bucket = 'available' THEN amount_micro END), 0) AS available,
              COALESCE(SUM(CASE WHEN bucket = 'frozen' THEN amount_micro END), 0) AS frozen FROM ledger_entries`,
    );
    const top = this.db
      .prepare(
        `SELECT w.user_id AS id, u.username, u.first_name AS firstName, COUNT(*) AS deals, SUM(COALESCE(w.final_rub, w.amount_rub)) AS rub
         FROM withdrawals w JOIN users u ON u.id = w.user_id
         WHERE w.status IN ('completed', 'user_confirmed') AND COALESCE(w.finished_at, w.user_confirmed_at, w.user_decided_at) >= ?
         GROUP BY w.user_id ORDER BY rub DESC LIMIT 10`,
      )
      .all(today - 6 * DAY) as AdminStatsDto['topUsers'];

    return {
      serverNow: now,
      periods,
      days,
      now: {
        activeDeals: statusRows.reduce((s, r) => s + r.n, 0),
        dealsByStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.n])),
        usdtPayoutsWaiting: this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM usdt_payouts WHERE status = 'new'`).n,
        depositsHeld: this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM deposits WHERE status = 'held'`).n,
        usersTotal: this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users').n,
        availableMicro: bal.available,
        frozenMicro: bal.frozen,
      },
      topUsers: top,
    };
  }
}
