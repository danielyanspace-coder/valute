import type { BonusDto, AdminPremiumDto, BuyPremiumRequest, PremiumStatusDto } from '../../../shared/api.js';
import { PREMIUM_CASHBACK_BPS, PREMIUM_CASHBACK_MIN_MICRO, PREMIUM_NAME, PREMIUM_PLANS, premiumPlan } from '../../../shared/premium.js';
import { shortUsdt } from '../../../shared/transfers.js';
import type { AuditLog } from '../audit/auditLog.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import { em } from '../notifications/emoji.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { UserRepo, UserRow } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';

const DAY = 86_400_000;
/** Months are counted in Moscow time (UTC+3, no daylight saving), like the stats. */
const MSK = 3 * 3_600_000;
const REMIND_BEFORE_MS = 3 * DAY;
const META_CASHBACK_MONTH = 'premium_cashback_month';

/** Is IX Black active for the user at this moment? Used when a request is created to set its priority. */
export function isPremium(db: Db, userId: number, at: number): boolean {
  return !!db.prepare('SELECT 1 FROM premium_subscriptions WHERE user_id = ? AND starts_at <= ? AND ends_at > ? LIMIT 1').get(userId, at, at);
}

/** Start of the Moscow month containing t, and the "YYYY-MM" key. */
export function mskMonth(t: number): { start: number; end: number; key: string } {
  const d = new Date(t + MSK);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    start: Date.UTC(y, m, 1) - MSK,
    end: Date.UTC(y, m + 1, 1) - MSK,
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
  };
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });

/**
 * Turnover that earns cashback: completed card withdrawals, sent USDT withdrawals and paid
 * service orders, counted only when they finished inside a paid IX Black period.
 * Transfers and checks are left out: moving money between one's own accounts must not earn anything.
 */
const TURNOVER_SQL = `
  SELECT t.user_id AS userId, COALESCE(SUM(t.amount_micro), 0) AS turnover FROM (
    SELECT user_id, amount_micro, finished_at FROM withdrawals WHERE status = 'completed'
    UNION ALL SELECT user_id, amount_micro, finished_at FROM usdt_payouts WHERE status = 'sent'
    UNION ALL SELECT user_id, amount_micro, finished_at FROM service_orders WHERE status = 'paid'
  ) t
  WHERE t.finished_at >= ? AND t.finished_at < ?
    AND EXISTS (SELECT 1 FROM premium_subscriptions s WHERE s.user_id = t.user_id AND s.starts_at <= t.finished_at AND s.ends_at > t.finished_at)
`;

/**
 * IX Black: paid from the balance for 30 or 90 days, stacking on top of the current period.
 * Gives priority in every admin queue and 0.2% cashback on the month's turnover, paid on the 1st.
 */
export class PremiumService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly users: UserRepo,
    private readonly notifications: NotificationService,
    private readonly audit?: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** End of the active period, or null. */
  until(userId: number, at = this.now()): number | null {
    const r = this.db.prepare('SELECT MAX(ends_at) AS e FROM premium_subscriptions WHERE user_id = ? AND starts_at <= ? AND ends_at > ?').get(userId, at, at) as { e: number | null };
    if (!r.e) return null;
    // Periods bought in advance start where the previous one ends.
    const last = this.db.prepare('SELECT MAX(ends_at) AS e FROM premium_subscriptions WHERE user_id = ?').get(userId) as { e: number };
    return last.e;
  }

  status(userId: number): PremiumStatusDto {
    const month = mskMonth(this.now());
    const turnover = this.db.prepare(`${TURNOVER_SQL} AND t.user_id = ?`).get(month.start, month.end, userId) as { turnover: number };
    const cashback = this.db
      .prepare('SELECT month, turnover_micro AS turnoverMicro, amount_micro AS amountMicro FROM premium_cashback WHERE user_id = ? ORDER BY month DESC LIMIT 12')
      .all(userId) as unknown as PremiumStatusDto['cashback'];
    return {
      until: this.until(userId),
      plans: PREMIUM_PLANS.map((p) => ({ id: p.id, title: p.title, days: p.days, priceMicro: p.priceMicro, note: p.note })),
      cashback,
      monthTurnoverMicro: turnover.turnover,
    };
  }

  buy(user: UserRow, req: BuyPremiumRequest): PremiumStatusDto {
    if (user.blocked) throw new AppError(403, 'blocked', 'Покупка недоступна. Свяжитесь с поддержкой');
    const plan = premiumPlan(String(req?.plan ?? ''));
    if (!plan) throw new AppError(400, 'plan', 'Выберите срок');
    const requestId = String(req?.requestId ?? '');
    if (!requestId || requestId.length > 64) throw new AppError(400, 'request_id', 'Некорректный запрос');

    const bought = transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM premium_subscriptions WHERE user_id = ? AND request_id = ?').get(user.id, requestId)) return null;
      const { availableMicro } = this.ledger.balances(user.id);
      if (availableMicro < plan.priceMicro) throw new AppError(400, 'insufficient', `Недостаточно средств: нужно ${shortUsdt(plan.priceMicro)} USDT`);
      const now = this.now();
      const start = Math.max(now, this.until(user.id) ?? 0);
      const end = start + plan.days * DAY;
      const res = this.db
        .prepare('INSERT INTO premium_subscriptions (user_id, request_id, plan, price_micro, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, requestId, plan.id, plan.priceMicro, start, end, now);
      const id = Number(res.lastInsertRowid);
      this.ledger.post([{ userId: user.id, bucket: 'available', amountMicro: -plan.priceMicro, kind: 'premium_purchase', refType: 'premium', refId: id }]);
      this.audit?.log({ actor: 'user', type: 'premium_bought', userId: user.id, amountMicro: plan.priceMicro, data: { plan: plan.id, until: end } });
      return end;
    });
    if (bought) {
      this.notifications.botOnly(
        user,
        `${em('brand')} <b>${PREMIUM_NAME} активен до ${fmtDate(bought)}</b>\n\nВаши заявки теперь обрабатываются первыми, а в начале месяца придёт кэшбэк 0.2% от оборота.`,
      );
    }
    return this.status(user.id);
  }

  /** Purchases, cashback and giveaway prizes for the history screen. */
  history(userId: number): { at: number; bonus: BonusDto }[] {
    const rows = this.db
      .prepare(
        `SELECT kind, amount_micro AS amountMicro, created_at AS at FROM ledger_entries
         WHERE user_id = ? AND bucket = 'available' AND kind IN ('premium_purchase', 'premium_cashback', 'giveaway_prize')
         ORDER BY id DESC LIMIT 100`,
      )
      .all(userId) as unknown as { kind: BonusDto['kind']; amountMicro: number; at: number }[];
    return rows.map((r) => ({ at: r.at, bonus: { kind: r.kind, amountMicro: r.amountMicro } }));
  }

  // ---------- background ----------

  /** Hourly: last month's cashback (once) and expiry reminders. */
  tick(): void {
    this.payCashback();
    this.remind();
  }

  /** Pays last month's cashback to everyone with IX Black turnover. Runs once per month. */
  payCashback(): void {
    const prev = mskMonth(mskMonth(this.now()).start - 1);
    const done = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_CASHBACK_MONTH) as { value: string } | undefined;
    if (done && done.value >= prev.key) return;
    const rows = this.db.prepare(`${TURNOVER_SQL} GROUP BY t.user_id`).all(prev.start, prev.end) as unknown as { userId: number; turnover: number }[];
    const paid: { userId: number; amount: number; turnover: number }[] = [];
    transaction(this.db, () => {
      for (const r of rows) {
        const amount = Math.floor((r.turnover * PREMIUM_CASHBACK_BPS) / 10_000);
        if (amount < PREMIUM_CASHBACK_MIN_MICRO) continue;
        const res = this.db
          .prepare('INSERT OR IGNORE INTO premium_cashback (user_id, month, turnover_micro, amount_micro, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(r.userId, prev.key, r.turnover, amount, this.now());
        if (!res.changes) continue;
        this.ledger.post([{ userId: r.userId, bucket: 'available', amountMicro: amount, kind: 'premium_cashback', refType: 'premium_cashback', comment: prev.key }]);
        this.audit?.log({ actor: 'system', type: 'premium_cashback', userId: r.userId, amountMicro: amount, data: { month: prev.key, turnoverMicro: r.turnover } });
        paid.push({ userId: r.userId, amount, turnover: r.turnover });
      }
      this.db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_CASHBACK_MONTH, prev.key);
    });
    for (const p of paid) {
      const user = this.users.get(p.userId);
      if (!user) continue;
      this.notifications.notify(user, 'premium_cashback', {
        amountMicro: p.amount,
        botText: `${em('brand')} <b>Кэшбэк ${PREMIUM_NAME}: +${shortUsdt(p.amount)} USDT</b>\n\n0.2% от оборота ${shortUsdt(p.turnover)} USDT за прошлый месяц уже на балансе.`,
      });
    }
  }

  /** Three days before the end and on the day it ends, unless the user already extended. */
  remind(): void {
    const now = this.now();
    const latest = this.db
      .prepare(
        `SELECT s.id, s.user_id AS userId, s.ends_at AS endsAt FROM premium_subscriptions s
         WHERE s.ends_at = (SELECT MAX(ends_at) FROM premium_subscriptions WHERE user_id = s.user_id) AND s.ends_at > ?`,
      )
      .all(now - DAY) as unknown as { id: number; userId: number; endsAt: number }[];
    for (const s of latest) {
      const kind = s.endsAt <= now ? 'ended' : s.endsAt - now <= REMIND_BEFORE_MS ? 'soon' : null;
      if (!kind) continue;
      const res = this.db.prepare('INSERT OR IGNORE INTO premium_reminders (subscription_id, kind) VALUES (?, ?)').run(s.id, kind);
      if (!res.changes) continue;
      const user = this.users.get(s.userId);
      if (!user) continue;
      const text =
        kind === 'soon'
          ? `${em('brand')} <b>${PREMIUM_NAME} действует до ${fmtDate(s.endsAt)}</b>\n\nПродлите статус в профиле кошелька, чтобы заявки и дальше шли без очереди.`
          : `${em('brand')} <b>Срок ${PREMIUM_NAME} закончился</b>\n\nЗаявки снова обрабатываются в общей очереди. Продлить можно в профиле кошелька.`;
      this.notifications.botOnly(user, text);
    }
  }

  // ---------- admin ----------

  adminSummary(): AdminPremiumDto {
    const now = this.now();
    const active = this.db
      .prepare(
        `SELECT u.id AS userId, u.first_name AS firstName, u.last_name AS lastName, u.username, MAX(s.ends_at) AS until
         FROM premium_subscriptions s JOIN users u ON u.id = s.user_id
         GROUP BY u.id HAVING MAX(s.ends_at) > ? ORDER BY until`,
      )
      .all(now) as unknown as { userId: number; firstName: string; lastName: string | null; username: string | null; until: number }[];
    const revenue = this.db.prepare('SELECT COALESCE(SUM(price_micro), 0) AS t FROM premium_subscriptions').get() as { t: number };
    const cashback = this.db.prepare('SELECT COALESCE(SUM(amount_micro), 0) AS t FROM premium_cashback').get() as { t: number };
    return {
      active: active.map((a) => ({ userId: a.userId, name: [a.firstName, a.lastName].filter(Boolean).join(' '), username: a.username, until: a.until })),
      revenueMicro: revenue.t,
      cashbackMicro: cashback.t,
    };
  }

  /** User ids with IX Black right now: the admin panel marks them with a badge. */
  activeUserIds(): Set<number> {
    const now = this.now();
    const rows = this.db.prepare('SELECT DISTINCT user_id AS id FROM premium_subscriptions WHERE starts_at <= ? AND ends_at > ?').all(now, now) as unknown as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }
}
