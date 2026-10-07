import type {
  AdminBoardDto,
  AdminReminderDto,
  AdminUserDto,
  AdminWithdrawalDto,
  AdminWithdrawalListItem,
  ArchiveQuery,
  CreateWithdrawalRequest,
  WithdrawalDto,
} from '../../../shared/api.js';
import {
  ADMIN_STATUS_LABEL,
  ACTIVE_STATUSES,
  BOARD_SECTIONS,
  INACTIVE_AFTER_MS,
  PLATFORM_TIMER_MS,
  adminCan,
  boardSection,
  correctionPlan,
  nextReminderAt,
  reminderMessage,
  remindersDue,
  userActions,
  userCan,
  validateReportedRub,
  type AdminDealAction,
  type BoardSection,
  type DealResolution,
  type DealStatus,
  type UserDealAction,
} from '../../../shared/deals.js';
import {
  CARD_BRAND_LABEL,
  cardBrand,
  formatCard,
  formatRuPhone,
  maskCard,
  normalizeRuPhone,
  usdtMicroForRub,
  validateCard,
  validatePayoutRub,
  validateRuPhone,
  type CardBrand,
} from '../../../shared/payout.js';
import { findBank } from '../../../shared/sbpBanks.js';
import { shortUsdt } from '../../../shared/transfers.js';
import type { AuditLog } from '../audit/auditLog.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import type { InlineButton, Messenger } from '../notifications/messenger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { ObligationService } from '../obligations/obligationService.js';
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
  status: DealStatus;
  created_at: number;
  finished_at: number | null;
  client_ip: string | null;
  user_agent: string | null;
  platform: string | null;
  taken_at: number | null;
  entered_at: number | null;
  requisite_off_at: number | null;
  reminders_sent: number;
  bot_message_id: number | null;
  inactive_since: number | null;
  user_decision: 'received' | 'not_received' | 'other_amount' | null;
  user_decided_at: number | null;
  reported_rub: number | null;
  user_confirmed_at: number | null;
  final_rub: number | null;
  debited_micro: number | null;
  refunded_micro: number | null;
  resolution: DealResolution | null;
  external_id: string | null;
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

export interface FinishOptions {
  /** Operator's own deal ID, offered before archiving; empty = skipped. */
  externalId?: string | null;
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const LOCK_MESSAGE = 'Действие недоступно. Свяжитесь с поддержкой';

/**
 * USDT → RUB withdrawal deals, paid by the operator by hand through an external platform.
 * Statuses and permissions come from shared/deals.ts; every money movement happens in a
 * DB transaction guarded on the previous status, so a double click cannot pay twice.
 */
export class WithdrawalService {
  /** Set after construction (the obligation service needs this one's AppError). */
  obligations: ObligationService | null = null;

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly ledger: Ledger,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLog,
    private readonly messenger: Messenger | null = null,
    private readonly webAppUrl: string = '',
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- Access ----------

  contactLock(userId: number): { since: number } | null {
    const u = this.users.get(userId);
    return u?.support_lock_at ? { since: u.support_lock_at } : null;
  }

  assertNotLocked(userId: number): void {
    if (this.contactLock(userId)) throw new AppError(423, 'locked', LOCK_MESSAGE);
  }

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

      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO withdrawals (user_id, request_id, method, phone, bank_id, bank_name, card_number, card_brand,
             amount_rub, amount_micro, rate, exchange_rate, balance_before_micro, status, created_at, client_ip, user_agent, platform)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
        )
        .run(
          user.id, req.requestId, req.method, phone, bank?.id ?? null, bank?.name ?? null, card,
          card ? cardBrand(card) : null, req.amountRub, amountMicro, quote.rate, quote.exchangeRate,
          availableMicro, this.now(), ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null, req.platform?.slice(0, 40) ?? null,
        );
      const id = Number(lastInsertRowid);
      this.ledger.post([
        { userId: user.id, bucket: 'available', amountMicro: -amountMicro, kind: 'withdrawal_freeze', refType: 'withdrawal', refId: id },
        { userId: user.id, bucket: 'frozen', amountMicro, kind: 'withdrawal_freeze', refType: 'withdrawal', refId: id },
      ]);
      this.log(id, user.id, 'user', 'deal_created', { amountMicro, amountRub: req.amountRub, data: { rate: quote.rate, method: req.method } });
      return this.row(id)!;
    });
  }

  /** Completed USDT → RUB withdrawals, shown in the profile as "exchanges". */
  exchangeStats(userId: number): { exchanges: number; exchangedRub: number } {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(final_rub, amount_rub)), 0) AS rub FROM withdrawals WHERE user_id = ? AND status = 'completed'`)
      .get(userId) as { n: number; rub: number };
    return { exchanges: r.n, exchangedRub: r.rub };
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

  /** "The money arrived": USDT are written off at once, the user is done with this deal. */
  userReceived(userId: number, id: number): WithdrawalRow {
    const w = this.userGuard(userId, id, 'received');
    const now = this.now();
    const row = transaction(this.db, () => {
      this.move(w, 'user_confirmed', {
        user_decision: 'received', user_decided_at: now, user_confirmed_at: now,
        debited_micro: w.amount_micro, final_rub: w.amount_rub,
      });
      this.ledger.post([
        { userId: w.user_id, bucket: 'frozen', amountMicro: -w.amount_micro, kind: 'withdrawal_payout', refType: 'withdrawal', refId: id },
      ]);
      this.log(id, w.user_id, 'user', 'user_received', { amountMicro: w.amount_micro, amountRub: w.amount_rub, data: { from: w.status, responseMs: this.responseMs(w) } });
      return this.row(id)!;
    });
    this.clearBotButtons(row, 'Получение подтверждено. Спасибо!');
    return row;
  }

  userNotReceived(userId: number, id: number): WithdrawalRow {
    const w = this.userGuard(userId, id, 'not_received');
    const row = transaction(this.db, () => {
      this.move(w, 'not_received', { user_decision: 'not_received', user_decided_at: this.now(), reported_rub: null });
      this.log(id, w.user_id, 'user', 'user_not_received', { amountRub: w.amount_rub, data: { from: w.status, responseMs: this.responseMs(w) } });
      return this.row(id)!;
    });
    this.clearBotButtons(row, 'Мы проверим платёж и свяжемся с вами. Если деньги придут, подтвердите получение в кошельке.');
    return row;
  }

  userOtherAmount(userId: number, id: number, reportedRub: number): WithdrawalRow {
    const err = validateReportedRub(reportedRub);
    if (err) throw new AppError(400, 'amount', err);
    const w = this.userGuard(userId, id, 'other_amount');
    const row = transaction(this.db, () => {
      this.move(w, 'mismatch', { user_decision: 'other_amount', user_decided_at: this.now(), reported_rub: reportedRub });
      this.log(id, w.user_id, 'user', 'user_other_amount', { amountRub: reportedRub, data: { from: w.status, originalRub: w.amount_rub } });
      return this.row(id)!;
    });
    this.clearBotButtons(row, `Вы сообщили о сумме ${rub(reportedRub)}. Мы проверим и сообщим результат.`);
    return row;
  }

  private userGuard(userId: number, id: number, action: UserDealAction): WithdrawalRow {
    this.assertNotLocked(userId);
    const w = this.getForUser(userId, id);
    if (!userCan({ status: w.status, enteredAt: w.entered_at }, action, this.now())) {
      throw new AppError(409, 'bad_status', w.status === 'user_confirmed' || w.status === 'completed' ? 'Сделка уже завершена' : 'Сейчас это действие недоступно');
    }
    return w;
  }

  private responseMs(w: WithdrawalRow): number | null {
    return w.entered_at ? this.now() - w.entered_at : null;
  }

  // ---------- Operator side ----------

  take(id: number): WithdrawalRow {
    return this.adminStep(id, 'take', (w) => {
      this.move(w, 'in_work', { taken_at: this.now() });
      this.log(id, w.user_id, 'admin', 'deal_taken', {});
    });
  }

  entered(id: number): WithdrawalRow {
    return this.adminStep(id, 'entered', (w) => {
      this.move(w, 'entered', { entered_at: this.now(), reminders_sent: 0, requisite_off_at: null });
      this.log(id, w.user_id, 'admin', 'deal_entered', { data: { requisite: requisite(w) } });
    });
  }

  requisiteOff(id: number): WithdrawalRow {
    return this.adminStep(id, 'requisite_off', (w) => {
      if (w.requisite_off_at) return;
      this.db.prepare('UPDATE withdrawals SET requisite_off_at = ? WHERE id = ?').run(this.now(), id);
      this.log(id, w.user_id, 'admin', 'requisite_off', { data: { requisite: requisite(w) } });
    });
  }

  /** The operator considers the deal paid (silent, "not received" or inactive user). */
  confirm(id: number, opts: FinishOptions = {}): WithdrawalRow {
    const row = this.adminStep(id, 'confirm', (w) => {
      this.payout(w, 'confirmed_admin', w.amount_micro, w.amount_rub, opts);
      this.log(id, w.user_id, 'admin', 'admin_confirmed', { amountMicro: w.amount_micro, amountRub: w.amount_rub, data: { from: w.status } });
    });
    this.tellUser(row, 'deal_completed', `Заявка №${row.id}: выплата ${rub(row.amount_rub)} подтверждена, сделка завершена.`);
    return row;
  }

  /** After the user's own confirmation: the operator closed the platform deal too. */
  close(id: number, opts: FinishOptions = {}): WithdrawalRow {
    return this.adminStep(id, 'close', (w) => {
      this.finish(w, 'completed', 'closed', opts, {});
      this.log(id, w.user_id, 'admin', 'deal_closed', {});
    });
  }

  /** The user confirmed by mistake: write-off is undone, the deal waits for a decision again. */
  reopen(id: number): WithdrawalRow {
    const row = this.adminStep(id, 'reopen', (w) => {
      this.move(w, 'not_received', { user_decision: null, user_decided_at: null, user_confirmed_at: null, debited_micro: null, final_rub: null });
      this.ledger.post([
        { userId: w.user_id, bucket: 'frozen', amountMicro: w.amount_micro, kind: 'withdrawal_reopen', refType: 'withdrawal', refId: id },
      ]);
      this.log(id, w.user_id, 'admin', 'deal_reopened', { amountMicro: w.amount_micro });
    });
    this.tellUser(row, 'deal_reminder', `По заявке №${row.id} нужна проверка. Откройте кошелёк и сообщите, поступили ли деньги.`);
    return row;
  }

  /** Pays by the amount the user reported, converted at the deal's own rate. */
  acceptCorrection(id: number, opts: FinishOptions & { createObligation?: boolean } = {}): WithdrawalRow {
    let plan = correctionPlan(0, 1, 0, 0);
    const row = this.adminStep(id, 'accept_correction', (w) => {
      const reported = w.reported_rub!;
      plan = correctionPlan(w.amount_micro, w.rate, reported, this.ledger.balances(w.user_id).availableMicro);
      const fromFrozen = Math.min(plan.correctedMicro, w.amount_micro);
      const entries: Parameters<Ledger['post']>[0] = [];
      if (fromFrozen) entries.push({ userId: w.user_id, bucket: 'frozen', amountMicro: -fromFrozen, kind: 'withdrawal_payout', refType: 'withdrawal', refId: id });
      if (plan.refundMicro) {
        entries.push(
          { userId: w.user_id, bucket: 'frozen', amountMicro: -plan.refundMicro, kind: 'withdrawal_refund', refType: 'withdrawal', refId: id },
          { userId: w.user_id, bucket: 'available', amountMicro: plan.refundMicro, kind: 'withdrawal_refund', refType: 'withdrawal', refId: id },
        );
      }
      if (plan.fromAvailableMicro) {
        entries.push({ userId: w.user_id, bucket: 'available', amountMicro: -plan.fromAvailableMicro, kind: 'withdrawal_payout_extra', refType: 'withdrawal', refId: id });
      }
      this.finish(w, 'completed', 'correction', opts, {
        final_rub: reported,
        debited_micro: fromFrozen + plan.fromAvailableMicro,
        refunded_micro: plan.refundMicro,
      });
      this.ledger.post(entries);
      this.log(id, w.user_id, 'admin', 'correction_accepted', {
        amountMicro: fromFrozen + plan.fromAvailableMicro,
        amountRub: reported,
        data: { originalRub: w.amount_rub, rate: w.rate, ...plan },
      });
      if (plan.shortageMicro > 0 && opts.createObligation) {
        if (!this.obligations) throw new AppError(500, 'obligations_off', 'Теневые заморозки недоступны');
        this.obligations.createInTx({
          userId: w.user_id,
          amountUsdt: plan.shortageMicro / 1_000_000,
          withdrawalId: id,
          comment: `Корректировка по заявке №${id}: получено ${rub(reported)} вместо ${rub(w.amount_rub)}, на балансе не хватило`,
        });
      }
    });
    const parts = [`По заявке №${row.id} принята сумма ${rub(row.final_rub!)}.`];
    if (plan.refundMicro) parts.push(`${shortUsdt(plan.refundMicro)} USDT вернулись на баланс.`);
    if (plan.fromAvailableMicro) parts.push(`Дополнительно списано ${shortUsdt(plan.fromAvailableMicro)} USDT.`);
    this.tellUser(row, 'deal_corrected', parts.join(' '));
    return row;
  }

  acceptOriginal(id: number, opts: FinishOptions = {}): WithdrawalRow {
    const row = this.adminStep(id, 'accept_original', (w) => {
      this.payout(w, 'original', w.amount_micro, w.amount_rub, opts);
      this.log(id, w.user_id, 'admin', 'original_accepted', { amountMicro: w.amount_micro, amountRub: w.amount_rub, data: { reportedRub: w.reported_rub } });
    });
    this.tellUser(row, 'deal_completed', `Заявка №${row.id} завершена по сумме сделки ${rub(row.amount_rub)}.`);
    return row;
  }

  cancel(id: number, opts: FinishOptions & { reason?: string } = {}): WithdrawalRow {
    const reason = (opts.reason ?? '').trim().slice(0, 500) || null;
    const row = this.adminStep(id, 'cancel', (w) => {
      this.finish(w, 'cancelled', 'cancelled', opts, { refunded_micro: w.amount_micro });
      this.ledger.post([
        { userId: w.user_id, bucket: 'frozen', amountMicro: -w.amount_micro, kind: 'withdrawal_refund', refType: 'withdrawal', refId: id },
        { userId: w.user_id, bucket: 'available', amountMicro: w.amount_micro, kind: 'withdrawal_refund', refType: 'withdrawal', refId: id },
      ]);
      this.log(id, w.user_id, 'admin', 'deal_cancelled', { amountMicro: w.amount_micro, amountRub: w.amount_rub, data: { from: w.status, reason } });
    });
    this.tellUser(row, 'deal_cancelled', `Заявка №${row.id} на ${rub(row.amount_rub)} отменена. ${shortUsdt(row.amount_micro)} USDT вернулись на баланс.`);
    return row;
  }

  setExternalId(id: number, externalId: string): WithdrawalRow {
    const ext = externalId.trim().slice(0, 100) || null;
    return transaction(this.db, () => {
      const w = this.mustRow(id);
      this.db.prepare('UPDATE withdrawals SET external_id = ? WHERE id = ?').run(ext, id);
      this.log(id, w.user_id, 'admin', 'external_id_set', { data: { externalId: ext, previous: w.external_id } });
      return this.row(id)!;
    });
  }

  addNote(id: number, text: string): WithdrawalRow {
    const note = text.trim().slice(0, 2000);
    if (!note) throw new AppError(400, 'note', 'Пустая заметка');
    const w = this.mustRow(id);
    this.log(id, w.user_id, 'admin', 'note', { data: { text: note } });
    return this.row(id)!;
  }

  private adminStep(id: number, action: AdminDealAction, fn: (w: WithdrawalRow) => void): WithdrawalRow {
    const row = transaction(this.db, () => {
      const w = this.mustRow(id);
      if (!adminCan(w.status, action)) {
        throw new AppError(409, 'bad_status', `Действие недоступно: сделка в статусе «${ADMIN_STATUS_LABEL[w.status]}»`);
      }
      fn(w);
      return this.row(id)!;
    });
    if (row.status === 'completed' || row.status === 'cancelled') this.clearBotButtons(row);
    return row;
  }

  /** Full write-off of the frozen USDT and archive. */
  private payout(w: WithdrawalRow, resolution: DealResolution, micro: number, rubPaid: number, opts: FinishOptions): void {
    this.finish(w, 'completed', resolution, opts, { final_rub: rubPaid, debited_micro: micro });
    this.ledger.post([
      { userId: w.user_id, bucket: 'frozen', amountMicro: -micro, kind: 'withdrawal_payout', refType: 'withdrawal', refId: w.id },
    ]);
  }

  private finish(w: WithdrawalRow, to: 'completed' | 'cancelled', resolution: DealResolution, opts: FinishOptions, fields: Partial<WithdrawalRow>): void {
    const ext = (opts.externalId ?? '').trim().slice(0, 100) || null;
    this.move(w, to, { ...fields, resolution, finished_at: this.now(), ...(ext ? { external_id: ext } : {}) });
    if (ext) this.log(w.id, w.user_id, 'admin', 'external_id_set', { data: { externalId: ext } });
  }

  // ---------- Timer: reminders and inactivity ----------

  /** Called every few seconds. Times come from stored timestamps, so restarts change nothing. */
  async tick(): Promise<void> {
    const now = this.now();
    const rows = this.db.prepare(`SELECT * FROM withdrawals WHERE status = 'entered' AND entered_at IS NOT NULL`).all() as unknown as WithdrawalRow[];
    for (const w of rows) {
      if (now >= w.entered_at! + INACTIVE_AFTER_MS) {
        const moved = transaction(this.db, () => {
          const res = this.db
            .prepare(`UPDATE withdrawals SET status = 'inactive', inactive_since = ? WHERE id = ? AND status = 'entered'`)
            .run(now, w.id);
          if (Number(res.changes) !== 1) return false;
          this.users.incrementMissedConfirmations(w.user_id);
          this.log(w.id, w.user_id, 'system', 'deal_inactive', { data: { remindersSent: w.reminders_sent } });
          return true;
        });
        if (moved) this.clearBotButtons(this.row(w.id)!, 'Время на подтверждение вышло. Сделка на рассмотрении администратора. Если деньги пришли, подтвердите получение в кошельке.');
        continue;
      }
      const due = remindersDue(w.entered_at!, now);
      if (due <= w.reminders_sent) continue;
      // Claim the reminder first: a second tick (or process) cannot send it twice.
      const claimed = this.db
        .prepare(`UPDATE withdrawals SET reminders_sent = ? WHERE id = ? AND reminders_sent = ? AND status = 'entered'`)
        .run(due, w.id, w.reminders_sent);
      if (Number(claimed.changes) !== 1) continue;
      await this.sendReminder({ ...w, reminders_sent: due }, due);
    }
  }

  private async sendReminder(w: WithdrawalRow, n: number): Promise<void> {
    const user = this.users.get(w.user_id);
    if (!user) return;
    let delivered = false;
    let error: string | null = null;
    // A user locked until they contact support cannot answer: no buttons that would not work.
    if (user.support_lock_at) {
      error = 'Заблокирован до связи с поддержкой';
    } else if (this.messenger) {
      this.notifications.notify(user, 'deal_reminder', { withdrawalId: w.id });
      if (w.bot_message_id) await this.messenger.editButtons(user.telegram_id, w.bot_message_id, []);
      const msg = reminderMessage(n, w.amount_rub, w.id);
      const res = await this.messenger.send(user.telegram_id, msg.text, { buttons: this.dealButtons(w, msg.receivedLabel) });
      if (res.ok) {
        delivered = true;
        this.db.prepare('UPDATE withdrawals SET bot_message_id = ? WHERE id = ?').run(res.messageId, w.id);
      } else {
        error = res.blocked ? 'Пользователь заблокировал бота' : res.error;
      }
    } else {
      this.notifications.notify(user, 'deal_reminder', { withdrawalId: w.id });
      error = 'Бот не подключён';
    }
    this.db
      .prepare('INSERT OR IGNORE INTO deal_reminders (withdrawal_id, n, at, delivered, error) VALUES (?, ?, ?, ?, ?)')
      .run(w.id, n, this.now(), delivered ? 1 : 0, error);
    this.log(w.id, w.user_id, 'system', 'reminder_sent', { data: { n, delivered, error } });
  }

  /** Buttons under a reminder; what is allowed is decided again when pressed. */
  dealButtons(w: WithdrawalRow, receivedLabel = 'Подтвердить получение'): InlineButton[][] {
    const actions = userActions({ status: w.status, enteredAt: w.entered_at }, this.now() + 1000);
    const rows: InlineButton[][] = [];
    if (actions.includes('received')) rows.push([{ text: receivedLabel, callback: `dr:${w.id}` }]);
    if (actions.includes('not_received')) rows.push([{ text: 'Оплата не поступила', callback: `dn:${w.id}` }]);
    if (actions.includes('other_amount')) {
      rows.push([
        this.webAppUrl
          ? { text: 'Поступила другая сумма', webApp: `${this.webAppUrl}${this.webAppUrl.includes('?') ? '&' : '?'}deal=${w.id}` }
          : { text: 'Поступила другая сумма', callback: `da:${w.id}` },
      ]);
    }
    return rows;
  }

  private clearBotButtons(w: WithdrawalRow, text?: string): void {
    if (!this.messenger || !w.bot_message_id) return;
    const user = this.users.get(w.user_id);
    if (!user) return;
    const p = text ? this.messenger.editText(user.telegram_id, w.bot_message_id, text) : this.messenger.editButtons(user.telegram_id, w.bot_message_id, []);
    void p.catch(() => {});
  }

  private tellUser(w: WithdrawalRow, type: 'deal_completed' | 'deal_cancelled' | 'deal_corrected' | 'deal_reminder', text: string): void {
    const user = this.users.get(w.user_id);
    if (user) this.notifications.notify(user, type, { withdrawalId: w.id, botText: text });
  }

  // ---------- Admin views ----------

  board(): AdminBoardDto {
    const rows = this.db
      .prepare(`SELECT * FROM withdrawals WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY created_at, id`)
      .all(...ACTIVE_STATUSES) as unknown as WithdrawalRow[];
    const items = rows.map((w) => this.listItem(w));
    const counts = Object.fromEntries(BOARD_SECTIONS.map((s) => [s.id, 0])) as Record<BoardSection, number>;
    for (const i of items) if (i.section) counts[i.section]++;
    return { items, counts, serverNow: this.now() };
  }

  archive(q: ArchiveQuery): AdminWithdrawalListItem[] {
    const where = [`w.status IN ('completed', 'cancelled')`];
    const args: (string | number)[] = [];
    if (q.status === 'completed' || q.status === 'cancelled') where.push('w.status = ?'), args.push(q.status);
    if (q.resolution) where.push('w.resolution = ?'), args.push(q.resolution);
    if (q.method === 'sbp' || q.method === 'card') where.push('w.method = ?'), args.push(q.method);
    if (q.from) where.push('w.created_at >= ?'), args.push(Number(q.from));
    if (q.to) where.push('w.created_at <= ?'), args.push(Number(q.to));
    const text = (q.q ?? '').trim();
    if (text) {
      const digits = text.replace(/[\s№#+()-]/g, '');
      const cond = ['w.external_id LIKE ? COLLATE NOCASE', 'u.username LIKE ? COLLATE NOCASE', 'u.first_name LIKE ? COLLATE NOCASE'];
      args.push(`%${text}%`, `%${text.replace(/^@/, '')}%`, `%${text}%`);
      if (/^\d+$/.test(digits)) {
        cond.push('w.id = ?', 'w.amount_rub = ?', 'w.final_rub = ?', 'w.phone LIKE ?', 'w.card_number LIKE ?');
        args.push(Number(digits), Number(digits), Number(digits), `%${digits}%`, `%${digits}%`);
      }
      where.push(`(${cond.join(' OR ')})`);
    }
    const rows = this.db
      .prepare(
        `SELECT w.* FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE ${where.join(' AND ')}
         ORDER BY w.finished_at DESC, w.id DESC LIMIT 100 OFFSET ?`,
      )
      .all(...args, Math.max(0, Number(q.offset) || 0)) as unknown as WithdrawalRow[];
    return rows.map((w) => this.listItem(w));
  }

  forUser(userId: number, limit = 100): AdminWithdrawalListItem[] {
    return this.listForUser(userId, limit).map((w) => this.listItem(w));
  }

  activeCount(userId: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
        .get(userId, ...ACTIVE_STATUSES) as { n: number }
    ).n;
  }

  adminGet(id: number): AdminWithdrawalDto {
    const w = this.mustRow(id);
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
    const reminders = (
      this.db.prepare('SELECT n, at, delivered, error FROM deal_reminders WHERE withdrawal_id = ? ORDER BY n').all(id) as unknown as {
        n: number;
        at: number;
        delivered: number;
        error: string | null;
      }[]
    ).map((r): AdminReminderDto => ({ n: r.n, at: r.at, delivered: !!r.delivered, error: r.error }));
    const correction =
      w.status === 'mismatch' && w.reported_rub
        ? { reportedRub: w.reported_rub, ...correctionPlan(w.amount_micro, w.rate, w.reported_rub, this.ledger.balances(w.user_id).availableMicro) }
        : null;
    return {
      ...this.listItem(w),
      phone: w.phone,
      cardNumber: w.card_number,
      cardBrand: w.card_brand ? CARD_BRAND_LABEL[w.card_brand] : null,
      rate: w.rate,
      exchangeRate: w.exchange_rate,
      balanceBeforeMicro: w.balance_before_micro,
      debitedMicro: w.debited_micro,
      refundedMicro: w.refunded_micro,
      userConfirmedAt: w.user_confirmed_at,
      inactiveSince: w.inactive_since,
      correction,
      clientIp: w.client_ip,
      userAgent: w.user_agent,
      platform: w.platform,
      reminders,
      events: this.audit.forDeal(id),
      userDetails: this.adminUser(w.user_id),
      sameDestinationUsers,
      recentWithdrawals: recent,
      obligations: this.obligations?.list({ userId: w.user_id }) ?? [],
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
                COALESCE(SUM(CASE WHEN status = 'completed' THEN COALESCE(final_rub, amount_rub) END), 0) AS rub,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN COALESCE(debited_micro, amount_micro) END), 0) AS micro
         FROM withdrawals WHERE user_id = ?`,
      )
      .get(userId) as { total: number; completed: number | null; rub: number; micro: number };
    const disputes = this.db
      .prepare(`SELECT COUNT(DISTINCT withdrawal_id) AS n FROM audit_log WHERE user_id = ? AND type = 'user_not_received'`)
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
      supportLockedAt: u.support_lock_at,
      botBlockedAt: u.bot_blocked_at,
      obligationsLeftMicro: this.obligations?.leftForUser(userId) ?? 0,
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
      this.audit.log({ actor: 'admin', type: 'manual_adjustment', userId, amountMicro, data: { comment: text } });
      this.ledger.post([{ userId, bucket: 'available', amountMicro, kind: 'manual_adjustment', comment: text }]);
    });
  }

  /** "Force to contact support": blocks every action until the operator lifts it. */
  setSupportLock(userId: number, locked: boolean, supportUsername: string): AdminUserDto {
    const u = this.users.get(userId);
    if (!u) throw new AppError(404, 'not_found', 'Пользователь не найден');
    if (!!u.support_lock_at === locked) return this.adminUser(userId);
    transaction(this.db, () => {
      this.users.setSupportLock(userId, locked);
      this.audit.log({ actor: 'admin', type: locked ? 'support_lock' : 'support_unlock', userId });
    });
    const buttons = locked && supportUsername ? [[{ text: 'Написать в поддержку', url: `https://t.me/${supportUsername}` }]] : undefined;
    this.notifications.notify(u, 'support_lock', {
      botText: locked
        ? 'Свяжитесь с поддержкой. Операции в кошельке приостановлены до связи с нами.'
        : 'Доступ к кошельку восстановлен. Спасибо!',
      buttons,
    });
    return this.adminUser(userId);
  }

  setBlocked(userId: number, blocked: boolean): AdminUserDto {
    if (!this.users.get(userId)) throw new AppError(404, 'not_found', 'Пользователь не найден');
    this.users.setBlocked(userId, blocked);
    this.audit.log({ actor: 'admin', type: blocked ? 'user_blocked' : 'user_unblocked', userId });
    return this.adminUser(userId);
  }

  // ---------- DTOs ----------

  toUserDto(w: WithdrawalRow): WithdrawalDto {
    const now = this.now();
    return {
      id: w.id,
      method: w.method,
      status: w.status,
      amountRub: w.amount_rub,
      amountMicro: w.amount_micro,
      rate: w.rate,
      destination: destination(w),
      createdAt: w.created_at,
      enteredAt: w.entered_at,
      actions: this.contactLock(w.user_id) ? [] : userActions({ status: w.status, enteredAt: w.entered_at }, now),
      userDecision: w.user_decision,
      reportedRub: w.reported_rub,
      finalRub: w.final_rub,
      debitedMicro: w.debited_micro,
      refundedMicro: w.refunded_micro,
      finishedAt: w.finished_at,
      resolution: w.resolution,
      serverNow: now,
    };
  }

  listItem(w: WithdrawalRow): AdminWithdrawalListItem {
    const u = this.users.get(w.user_id);
    const entered = w.entered_at;
    return {
      id: w.id,
      status: w.status,
      section: boardSection({ status: w.status, requisiteOffAt: w.requisite_off_at }),
      method: w.method,
      amountRub: w.amount_rub,
      amountMicro: w.amount_micro,
      destination: destination(w),
      requisite: requisite(w),
      bankId: w.bank_id,
      bankName: w.bank_name,
      createdAt: w.created_at,
      takenAt: w.taken_at,
      enteredAt: entered,
      requisiteOffAt: w.requisite_off_at,
      remindersSent: w.reminders_sent,
      nextReminderAt: w.status === 'entered' && entered ? nextReminderAt(entered, w.reminders_sent) : null,
      inactiveAt: w.status === 'entered' && entered ? entered + INACTIVE_AFTER_MS : null,
      platformDeadline: entered && !w.finished_at ? entered + PLATFORM_TIMER_MS : null,
      userDecision: w.user_decision,
      userDecidedAt: w.user_decided_at,
      reportedRub: w.reported_rub,
      externalId: w.external_id,
      resolution: w.resolution,
      finalRub: w.final_rub,
      finishedAt: w.finished_at,
      user: {
        id: w.user_id,
        username: u?.username ?? null,
        firstName: u?.first_name ?? '',
        telegramId: u?.telegram_id ?? 0,
        supportLocked: !!u?.support_lock_at,
        botBlocked: !!u?.bot_blocked_at,
      },
    };
  }

  // ---------- Internals ----------

  private move(w: WithdrawalRow, to: DealStatus, fields: Partial<WithdrawalRow>): void {
    const sets = Object.keys(fields).map((k) => `${k} = :${k}`);
    // Guard on the old status so two concurrent clicks cannot both succeed.
    const res = this.db
      .prepare(`UPDATE withdrawals SET ${['status = :to', ...sets].join(', ')} WHERE id = :id AND status = :from`)
      .run({ ...(fields as Record<string, string | number | null>), to, id: w.id, from: w.status });
    if (Number(res.changes) !== 1) throw new AppError(409, 'conflict', 'Сделка уже изменилась, обновите страницу');
  }

  private log(
    withdrawalId: number,
    userId: number,
    actor: 'user' | 'admin' | 'system',
    type: Parameters<AuditLog['log']>[0]['type'],
    extra: { amountMicro?: number; amountRub?: number; data?: Record<string, unknown> },
  ): void {
    this.audit.log({ actor, type, userId, withdrawalId, amountMicro: extra.amountMicro ?? null, amountRub: extra.amountRub ?? null, data: extra.data ?? null });
  }

  row(id: number): WithdrawalRow | undefined {
    return this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id) as unknown as WithdrawalRow | undefined;
  }

  private mustRow(id: number): WithdrawalRow {
    const w = this.row(id);
    if (!w) throw new AppError(404, 'not_found', 'Заявка не найдена');
    return w;
  }
}

function destination(w: WithdrawalRow): string {
  if (w.method === 'sbp') return `${formatRuPhone(w.phone ?? '')} · ${w.bank_name ?? 'СБП'}`;
  const brand = w.card_brand ? CARD_BRAND_LABEL[w.card_brand] : 'Карта';
  return `${brand} ${maskCard(w.card_number ?? '')}`;
}

/** The requisite as it is entered on the platform: what to disable after "executor entered". */
function requisite(w: WithdrawalRow): string {
  if (w.method === 'sbp') return `${formatRuPhone(w.phone ?? '')} (${w.bank_name ?? 'СБП'})`;
  return formatCard(w.card_number ?? '');
}
