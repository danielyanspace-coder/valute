import type {
  AdminCounts,
  AdminUserDto,
  AdminWithdrawalDto,
  AdminWithdrawalListItem,
  CreateWithdrawalRequest,
  WithdrawalDto,
  WithdrawalEventDto,
} from '../../../shared/api.js';
import {
  CARD_BRAND_LABEL,
  CONFIRM_WINDOW_MS,
  cardBrand,
  formatRuPhone,
  maskCard,
  isFinal,
  nextStatus,
  normalizeRuPhone,
  STATUS_LABEL,
  usdtMicroForRub,
  validateCard,
  validatePayoutRub,
  validateRuPhone,
  type CardBrand,
  type WithdrawalAction,
  type WithdrawalStatus,
} from '../../../shared/payout.js';
import { findBank } from '../../../shared/sbpBanks.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { UserRepo, UserRow } from '../users/userRepo.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface WithdrawalRow {
  id: number;
  user_id: number;
  request_id: string;
  method: 'sbp' | 'card';
  phone: string | null;
  bank_id: string | null;
  bank_name: string | null;
  card_number: string | null;
  card_brand: CardBrand | null;
  amount_rub: number;
  amount_micro: number;
  rate: number;
  exchange_rate: number | null;
  balance_before_micro: number;
  status: WithdrawalStatus;
  created_at: number;
  sent_at: number | null;
  confirm_deadline: number | null;
  finished_at: number | null;
  confirmed_by: 'user' | 'auto' | 'admin' | null;
  reject_reason: string | null;
  contact_requested_at: number | null;
  client_ip: string | null;
  user_agent: string | null;
  platform: string | null;
}

export interface RateQuote {
  /** RUB per 1 USDT applied to this withdrawal. */
  rate: number;
  /** Rapira price the rate was derived from, kept for audit. */
  exchangeRate: number;
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

type Actor = 'user' | 'admin' | 'system';

export class WithdrawalService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly ledger: Ledger,
    private readonly notifications: NotificationService,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- User side ----------

  create(user: UserRow, req: CreateWithdrawalRequest, quote: RateQuote | null, ctx: RequestContext = {}): WithdrawalRow {
    if (user.blocked) throw new AppError(403, 'blocked', 'Вывод недоступен. Свяжитесь с поддержкой');
    this.assertNotLocked(user.id);
    if (req.acceptedTerms !== true) throw new AppError(400, 'terms', 'Нужно принять условия вывода');
    if (!req.requestId || req.requestId.length > 64) throw new AppError(400, 'request_id', 'Некорректный запрос');

    const existing = this.db
      .prepare('SELECT * FROM withdrawals WHERE user_id = ? AND request_id = ?')
      .get(user.id, req.requestId) as unknown as WithdrawalRow | undefined;
    if (existing) return existing; // repeated tap or network retry

    if (!quote) throw new AppError(503, 'rate_unavailable', 'Курс временно недоступен, попробуйте через минуту');

    const amountError = validatePayoutRub(req.amountRub);
    if (amountError) throw new AppError(400, 'amount', amountError);

    let phone: string | null = null;
    let bank: { id: string; name: string } | null = null;
    let card: string | null = null;
    if (req.method === 'sbp') {
      const phoneError = validateRuPhone(req.phone ?? '');
      if (phoneError) throw new AppError(400, 'phone', phoneError);
      const found = findBank(req.bankId ?? '');
      if (!found) throw new AppError(400, 'bank', 'Выберите банк');
      phone = normalizeRuPhone(req.phone!);
      bank = { id: found.id, name: found.name };
    } else if (req.method === 'card') {
      const cardError = validateCard(req.cardNumber ?? '');
      if (cardError) throw new AppError(400, 'card', cardError);
      card = req.cardNumber!.replace(/\D/g, '');
    } else {
      throw new AppError(400, 'method', 'Выберите способ вывода');
    }

    const amountMicro = usdtMicroForRub(req.amountRub, quote.rate);

    return transaction(this.db, () => {
      const { availableMicro } = this.ledger.balances(user.id);
      if (availableMicro < amountMicro) throw new AppError(400, 'insufficient', 'Недостаточно средств');

      const now = this.now();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO withdrawals (user_id, request_id, method, phone, bank_id, bank_name, card_number, card_brand,
             amount_rub, amount_micro, rate, exchange_rate, balance_before_micro, status, created_at, client_ip, user_agent, platform)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          user.id, req.requestId, req.method, phone, bank?.id ?? null, bank?.name ?? null, card,
          card ? cardBrand(card) : null, req.amountRub, amountMicro, quote.rate, quote.exchangeRate,
          availableMicro, now, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null, req.platform?.slice(0, 40) ?? null,
        );
      const id = Number(lastInsertRowid);
      this.ledger.post([
        { userId: user.id, bucket: 'available', amountMicro: -amountMicro, kind: 'withdrawal_freeze', refType: 'withdrawal', refId: id },
        { userId: user.id, bucket: 'frozen', amountMicro, kind: 'withdrawal_freeze', refType: 'withdrawal', refId: id },
      ]);
      this.event(id, 'user', 'created', { amountRub: req.amountRub, amountMicro, rate: quote.rate });
      return this.row(id)!;
    });
  }

  /** Active "contact support" request: the wallet stays locked until the deal is completed or rejected. */
  contactLock(userId: number): { withdrawalId: number; amountRub: number } | null {
    const row = this.db
      .prepare(
        `SELECT id, amount_rub FROM withdrawals
         WHERE user_id = ? AND contact_requested_at IS NOT NULL AND status IN ('pending', 'sent', 'disputed')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(userId) as { id: number; amount_rub: number } | undefined;
    return row ? { withdrawalId: row.id, amountRub: row.amount_rub } : null;
  }

  /** Completed USDT → RUB withdrawals, shown in the profile as "exchanges". */
  exchangeStats(userId: number): { exchanges: number; exchangedRub: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_rub), 0) AS rub FROM withdrawals WHERE user_id = ? AND status = 'completed'`)
      .get(userId) as { n: number; rub: number };
    return { exchanges: r.n, exchangedRub: r.rub };
  }

  assertNotLocked(userId: number): void {
    if (this.contactLock(userId)) {
      throw new AppError(423, 'locked', 'Кошелёк временно недоступен. Свяжитесь с поддержкой, чтобы завершить заявку');
    }
  }

  listForUser(userId: number, limit = 50): WithdrawalRow[] {
    return this.db
      .prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit) as unknown as WithdrawalRow[];
  }

  getForUser(userId: number, id: number): WithdrawalRow {
    const w = this.row(id);
    if (!w || w.user_id !== userId) throw new AppError(404, 'not_found', 'Заявка не найдена');
    return w;
  }

  confirmByUser(userId: number, id: number): WithdrawalRow {
    this.getForUser(userId, id);
    return this.complete(id, 'confirm_user', 'user');
  }

  disputeByUser(userId: number, id: number): WithdrawalRow {
    const w = this.getForUser(userId, id);
    return transaction(this.db, () => {
      this.transition(w, 'dispute', {});
      const user = this.users.get(userId)!;
      // Snapshot the username at dispute time: this is what support uses to reach the user.
      this.event(id, 'user', 'disputed', { username: user.username });
      return this.row(id)!;
    });
  }

  // ---------- Admin side ----------

  markSent(id: number): WithdrawalRow {
    return transaction(this.db, () => {
      const w = this.mustRow(id);
      const now = this.now();
      const deadline = now + CONFIRM_WINDOW_MS;
      this.transition(w, 'mark_sent', { sent_at: now, confirm_deadline: deadline });
      this.event(id, 'admin', 'marked_sent', { deadline, resend: w.status === 'disputed' });
      this.notifications.notify(this.users.get(w.user_id)!, 'confirm_receipt', w);
      return this.row(id)!;
    });
  }

  confirmByAdmin(id: number): WithdrawalRow {
    return this.complete(id, 'confirm_admin', 'admin');
  }

  reject(id: number, reason: string): WithdrawalRow {
    const text = reason.trim().slice(0, 500);
    if (!text) throw new AppError(400, 'reason', 'Укажите причину отклонения');
    return transaction(this.db, () => {
      const w = this.mustRow(id);
      this.transition(w, 'reject', { finished_at: this.now(), reject_reason: text });
      this.ledger.post([
        { userId: w.user_id, bucket: 'frozen', amountMicro: -w.amount_micro, kind: 'withdrawal_refund', refType: 'withdrawal', refId: id },
        { userId: w.user_id, bucket: 'available', amountMicro: w.amount_micro, kind: 'withdrawal_refund', refType: 'withdrawal', refId: id },
      ]);
      this.event(id, 'admin', 'rejected', { reason: text });
      this.notifications.notify(this.users.get(w.user_id)!, 'withdrawal_rejected', w);
      return this.row(id)!;
    });
  }

  requestContact(id: number): WithdrawalRow {
    return transaction(this.db, () => {
      const w = this.mustRow(id);
      if (isFinal(w.status)) throw new AppError(409, 'bad_status', 'Заявка уже завершена');
      this.db.prepare('UPDATE withdrawals SET contact_requested_at = ? WHERE id = ?').run(this.now(), id);
      this.event(id, 'admin', 'contact_requested', {});
      this.notifications.notify(this.users.get(w.user_id)!, 'contact_support', w);
      return this.row(id)!;
    });
  }

  addNote(id: number, text: string): WithdrawalRow {
    const note = text.trim().slice(0, 2000);
    if (!note) throw new AppError(400, 'note', 'Пустая заметка');
    this.mustRow(id);
    this.event(id, 'admin', 'note', { text: note });
    return this.row(id)!;
  }

  /** Auto-confirms deals whose 10-minute window ran out. Called by a timer. */
  autoConfirmDue(): number {
    const due = this.db
      .prepare(`SELECT id, user_id FROM withdrawals WHERE status = 'sent' AND confirm_deadline <= ?`)
      .all(this.now()) as unknown as { id: number; user_id: number }[];
    for (const { id, user_id } of due) {
      this.complete(id, 'confirm_auto', 'system');
      this.users.incrementMissedConfirmations(user_id);
    }
    return due.length;
  }

  counts(): AdminCounts {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM withdrawals GROUP BY status').all() as unknown as {
      status: WithdrawalStatus;
      n: number;
    }[];
    const c: AdminCounts = { pending: 0, sent: 0, disputed: 0, completed: 0, rejected: 0 };
    for (const r of rows) c[r.status] = r.n;
    return c;
  }

  adminList(status: WithdrawalStatus | 'all', limit = 200): AdminWithdrawalListItem[] {
    const rows = (
      status === 'all'
        ? this.db.prepare('SELECT * FROM withdrawals ORDER BY id DESC LIMIT ?').all(limit)
        : this.db.prepare('SELECT * FROM withdrawals WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    ) as unknown as WithdrawalRow[];
    return rows.map((w) => this.listItem(w));
  }

  adminGet(id: number): AdminWithdrawalDto {
    const w = this.mustRow(id);
    const events = (
      this.db.prepare('SELECT * FROM withdrawal_events WHERE withdrawal_id = ? ORDER BY id').all(id) as unknown as {
        id: number;
        at: number;
        actor: Actor;
        type: string;
        data: string | null;
      }[]
    ).map((e): WithdrawalEventDto => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));

    const sameDestinationUsers = this.db
      .prepare(
        `SELECT u.id, u.username, u.first_name AS firstName, COUNT(*) AS withdrawals
         FROM withdrawals w JOIN users u ON u.id = w.user_id
         WHERE w.user_id != ? AND ((? IS NOT NULL AND w.phone = ?) OR (? IS NOT NULL AND w.card_number = ?))
         GROUP BY u.id`,
      )
      .all(w.user_id, w.phone, w.phone, w.card_number, w.card_number) as unknown as AdminWithdrawalDto['sameDestinationUsers'];

    const recent = (
      this.db
        .prepare('SELECT * FROM withdrawals WHERE user_id = ? AND id != ? ORDER BY id DESC LIMIT 10')
        .all(w.user_id, id) as unknown as WithdrawalRow[]
    ).map((r) => this.listItem(r));

    return {
      ...this.listItem(w),
      phone: w.phone,
      bankId: w.bank_id,
      bankName: w.bank_name,
      cardNumber: w.card_number,
      cardBrand: w.card_brand ? CARD_BRAND_LABEL[w.card_brand] : null,
      rate: w.rate,
      exchangeRate: w.exchange_rate,
      balanceBeforeMicro: w.balance_before_micro,
      sentAt: w.sent_at,
      finishedAt: w.finished_at,
      confirmedBy: w.confirmed_by,
      rejectReason: w.reject_reason,
      contactRequestedAt: w.contact_requested_at,
      clientIp: w.client_ip,
      userAgent: w.user_agent,
      platform: w.platform,
      events,
      userDetails: this.adminUser(w.user_id),
      sameDestinationUsers,
      recentWithdrawals: recent,
      serverNow: this.now(),
    };
  }

  adminUser(userId: number): AdminUserDto {
    const u = this.users.get(userId);
    if (!u) throw new AppError(404, 'not_found', 'Пользователь не найден');
    const { availableMicro, frozenMicro } = this.ledger.balances(userId);
    const s = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(status = 'completed') AS completed,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_rub END), 0) AS rub,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN amount_micro END), 0) AS micro
         FROM withdrawals WHERE user_id = ?`,
      )
      .get(userId) as { total: number; completed: number | null; rub: number; micro: number };
    const disputes = this.db
      .prepare(
        `SELECT COUNT(DISTINCT e.withdrawal_id) AS n FROM withdrawal_events e
         JOIN withdrawals w ON w.id = e.withdrawal_id WHERE w.user_id = ? AND e.type = 'disputed'`,
      )
      .get(userId) as { n: number };
    return {
      id: u.id,
      telegramId: u.telegram_id,
      username: u.username,
      firstName: u.first_name,
      lastName: u.last_name,
      photoUrl: u.photo_url,
      languageCode: u.language_code,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at,
      blocked: !!u.blocked,
      missedConfirmations: u.missed_confirmations,
      availableMicro,
      frozenMicro,
      depositAddresses: this.users.depositAddresses(userId),
      stats: {
        depositedMicro: this.ledger.totalByKind(userId, 'deposit'),
        withdrawnRub: s.rub,
        withdrawnMicro: s.micro,
        withdrawalsTotal: s.total,
        withdrawalsCompleted: s.completed ?? 0,
        disputes: disputes.n,
        ...this.transferTotals(userId),
      },
    };
  }

  private transferTotals(userId: number) {
    const q = (sql: string) => (this.db.prepare(sql).get(userId) as { t: number }).t;
    return {
      transfersInMicro: q('SELECT COALESCE(SUM(amount_micro), 0) AS t FROM transfers WHERE to_user_id = ?'),
      transfersOutMicro: q('SELECT COALESCE(SUM(amount_micro), 0) AS t FROM transfers WHERE from_user_id = ?'),
      activeChecksMicro: q(`SELECT COALESCE(SUM(amount_micro), 0) AS t FROM checks WHERE creator_id = ? AND status = 'active'`),
    };
  }

  /** Manual balance correction (e.g. a deposit credited by hand). Positive or negative. */
  adjustBalance(userId: number, amountMicro: number, comment: string): void {
    if (!Number.isInteger(amountMicro) || amountMicro === 0) throw new AppError(400, 'amount', 'Укажите сумму');
    const text = comment.trim().slice(0, 500);
    if (!text) throw new AppError(400, 'comment', 'Укажите причину корректировки');
    if (!this.users.get(userId)) throw new AppError(404, 'not_found', 'Пользователь не найден');
    transaction(this.db, () => {
      if (amountMicro < 0 && this.ledger.balances(userId).availableMicro + amountMicro < 0) {
        throw new AppError(400, 'insufficient', 'Баланс не может стать отрицательным');
      }
      this.ledger.post([{ userId, bucket: 'available', amountMicro, kind: 'manual_adjustment', comment: text }]);
    });
  }

  // ---------- DTOs ----------

  toUserDto(w: WithdrawalRow): WithdrawalDto {
    return {
      id: w.id,
      method: w.method,
      status: w.status,
      amountRub: w.amount_rub,
      amountMicro: w.amount_micro,
      rate: w.rate,
      destination: destination(w),
      createdAt: w.created_at,
      sentAt: w.sent_at,
      confirmDeadline: w.confirm_deadline,
      finishedAt: w.finished_at,
      confirmedBy: w.confirmed_by,
      rejectReason: w.reject_reason,
      serverNow: this.now(),
    };
  }

  // ---------- Internals ----------

  private complete(id: number, action: WithdrawalAction, actor: Actor): WithdrawalRow {
    const by = action === 'confirm_user' ? 'user' : action === 'confirm_auto' ? 'auto' : 'admin';
    return transaction(this.db, () => {
      const w = this.mustRow(id);
      this.transition(w, action, { finished_at: this.now(), confirmed_by: by });
      this.ledger.post([
        { userId: w.user_id, bucket: 'frozen', amountMicro: -w.amount_micro, kind: 'withdrawal_payout', refType: 'withdrawal', refId: id },
      ]);
      this.event(id, actor, 'confirmed', { by, previousStatus: w.status });
      if (by !== 'user') this.notifications.notify(this.users.get(w.user_id)!, 'withdrawal_completed', w);
      return this.row(id)!;
    });
  }

  private transition(w: WithdrawalRow, action: WithdrawalAction, fields: Partial<WithdrawalRow>): void {
    const to = nextStatus(w.status, action);
    if (!to) throw new AppError(409, 'bad_status', `Действие недоступно: заявка в статусе «${STATUS_LABEL[w.status]}»`);
    const sets = Object.keys(fields).map((k) => `${k} = :${k}`);
    // Guard on the old status so two concurrent clicks cannot both succeed.
    const res = this.db
      .prepare(`UPDATE withdrawals SET ${['status = :to', ...sets].join(', ')} WHERE id = :id AND status = :from`)
      .run({ ...(fields as Record<string, string | number | null>), to, id: w.id, from: w.status });
    if (res.changes !== 1) throw new AppError(409, 'conflict', 'Заявка уже изменилась, обновите страницу');
  }

  private event(withdrawalId: number, actor: Actor, type: string, data: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO withdrawal_events (withdrawal_id, at, actor, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(withdrawalId, this.now(), actor, type, JSON.stringify(data));
  }

  private row(id: number): WithdrawalRow | undefined {
    return this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id) as unknown as WithdrawalRow | undefined;
  }

  private mustRow(id: number): WithdrawalRow {
    const w = this.row(id);
    if (!w) throw new AppError(404, 'not_found', 'Заявка не найдена');
    return w;
  }

  private listItem(w: WithdrawalRow): AdminWithdrawalListItem {
    const u = this.users.get(w.user_id)!;
    return {
      id: w.id,
      status: w.status,
      method: w.method,
      amountRub: w.amount_rub,
      amountMicro: w.amount_micro,
      destination: destination(w),
      bankId: w.bank_id,
      createdAt: w.created_at,
      confirmDeadline: w.confirm_deadline,
      user: { id: u.id, username: u.username, firstName: u.first_name },
    };
  }
}

function destination(w: WithdrawalRow): string {
  if (w.method === 'sbp') return `${formatRuPhone(w.phone ?? '')} · ${w.bank_name}`;
  const brand = w.card_brand ? CARD_BRAND_LABEL[w.card_brand] : 'Карта';
  return `${brand || 'Карта'} ${maskCard(w.card_number ?? '')}`;
}
