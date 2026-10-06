// In-browser copy of the server deal logic for the demo build. Same rules (shared/deals.ts),
// simplified storage. A time warp lets the demo skip the 2-minute reminder intervals.
import type {
  AdminAuditItem,
  AdminBoardDto,
  AdminBroadcastDto,
  AdminObligationDto,
  AdminUserDto,
  AdminUserListItem,
  AdminUserPageDto,
  AdminWithdrawalDto,
  AdminWithdrawalListItem,
  ArchiveQuery,
  BroadcastRequest,
  CreateObligationRequest,
  CreateWithdrawalRequest,
  DeductionDto,
  JournalQuery,
  NotificationDto,
  NotificationType,
  WithdrawalDto,
} from '../../../shared/api';
import { AUDIT_TYPES, type AuditActor, type AuditType } from '../../../shared/audit';
import {
  ACTIVE_STATUSES,
  ADMIN_STATUS_LABEL,
  BOARD_SECTIONS,
  INACTIVE_AFTER_MS,
  PLATFORM_TIMER_MS,
  REMINDER_INTERVAL_MS,
  adminCan,
  boardSection,
  correctionPlan,
  nextReminderAt,
  remindersDue,
  userActions,
  userCan,
  validateReportedRub,
  type AdminDealAction,
  type BoardSection,
  type DealResolution,
  type DealStatus,
  type UserDealAction,
} from '../../../shared/deals';
import {
  CARD_BRAND_LABEL,
  USDT_MICRO,
  cardBrand,
  formatCard,
  formatRuPhone,
  maskCard,
  normalizeRuPhone,
  usdtMicroForRub,
  validateCard,
  validatePayoutRub,
  validateRuPhone,
} from '../../../shared/payout';
import { findBank } from '../../../shared/sbpBanks';
import { ApiError, type DealActionPath } from './api';

export interface DemoUser {
  id: number;
  telegramId: number;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string;
  createdAt: number;
  lastSeenAt: number;
  blocked: boolean;
  missedConfirmations: number;
  availableMicro: number;
  frozenMicro: number;
  depositedMicro: number;
  addresses: { chain: string; address: string; createdAt: number }[];
  supportLockedAt: number | null;
  botBlockedAt: number | null;
}

interface Deal {
  id: number;
  userId: number;
  requestId: string;
  method: 'sbp' | 'card';
  phone: string | null;
  bankId: string | null;
  bankName: string | null;
  cardNumber: string | null;
  amountRub: number;
  amountMicro: number;
  rate: number;
  exchangeRate: number;
  balanceBeforeMicro: number;
  status: DealStatus;
  createdAt: number;
  takenAt: number | null;
  enteredAt: number | null;
  requisiteOffAt: number | null;
  remindersSent: number;
  reminders: { n: number; at: number; delivered: boolean; error: string | null }[];
  inactiveSince: number | null;
  userDecision: 'received' | 'not_received' | 'other_amount' | null;
  userDecidedAt: number | null;
  reportedRub: number | null;
  userConfirmedAt: number | null;
  finalRub: number | null;
  debitedMicro: number | null;
  refundedMicro: number | null;
  resolution: DealResolution | null;
  externalId: string | null;
  finishedAt: number | null;
  platform: string;
}

interface Obligation {
  id: number;
  userId: number;
  amountMicro: number;
  repaidMicro: number;
  status: 'active' | 'repaid' | 'written_off';
  publicReason: string;
  comment: string | null;
  withdrawalId: number | null;
  createdAt: number;
  repaidAt: number | null;
  writtenOffAt: number | null;
  writeOffComment: string | null;
  repayments: { at: number; amountMicro: number }[];
}

export interface DealEngineCtx {
  users: DemoUser[];
  notify: (userId: number, type: NotificationType, withdrawalId: number | null, extra?: Partial<NotificationDto>) => void;
  walletRate: () => number;
  transfersIn: (userId: number) => number;
  transfersOut: (userId: number) => number;
  activeChecks: (userId: number) => number;
}

const fail = (status: number, message: string): never => {
  throw new ApiError(status, 'demo', message);
};
const MIN = 60_000;
const DEFAULT_REASON = 'в предыдущей сделке вам было перечислено больше необходимой суммы';
const PATH_ACTION: Partial<Record<DealActionPath, AdminDealAction>> = {
  take: 'take', entered: 'entered', 'requisite-off': 'requisite_off', confirm: 'confirm', close: 'close', reopen: 'reopen',
  'accept-correction': 'accept_correction', 'accept-original': 'accept_original', cancel: 'cancel',
};

export function createDealEngine(ctx: DealEngineCtx) {
  let warp = 0;
  const now = () => Date.now() + warp;
  const deals: Deal[] = [];
  const audit: AdminAuditItem[] = [];
  const obligations: Obligation[] = [];
  const broadcasts: AdminBroadcastDto[] = [];
  let auditId = 1;
  let dealId = 1000;
  let obligationId = 1;
  let deductionId = 1;
  const deductions: (DeductionDto & { userId: number })[] = [];

  const user = (id: number) => ctx.users.find((u) => u.id === id) ?? fail(404, 'Пользователь не найден');
  const deal = (id: number) => deals.find((d) => d.id === id) ?? fail(404, 'Заявка не найдена');

  const log = (actor: AuditActor, type: AuditType, e: { userId?: number; withdrawalId?: number; obligationId?: number; amountMicro?: number; amountRub?: number; data?: Record<string, unknown>; at?: number }) => {
    const u = e.userId ? ctx.users.find((x) => x.id === e.userId) : undefined;
    audit.push({
      id: auditId++, at: e.at ?? now(), actor, type, label: AUDIT_TYPES[type], userId: e.userId ?? null, username: u?.username ?? null,
      firstName: u?.firstName ?? null, withdrawalId: e.withdrawalId ?? null, obligationId: e.obligationId ?? null,
      amountMicro: e.amountMicro ?? null, amountRub: e.amountRub ?? null, data: e.data ?? null,
    });
  };

  // ---------- shadow obligations ----------

  const settle = (userId: number) => {
    const u = user(userId);
    let held = 0;
    let firstId = 0;
    const reasons: string[] = [];
    for (const o of obligations.filter((x) => x.userId === userId && x.status === 'active')) {
      if (u.availableMicro <= 0) break;
      const take = Math.min(o.amountMicro - o.repaidMicro, u.availableMicro);
      if (take <= 0) continue;
      u.availableMicro -= take;
      o.repaidMicro += take;
      o.repayments.push({ at: now(), amountMicro: take });
      if (o.repaidMicro >= o.amountMicro) Object.assign(o, { status: 'repaid', repaidAt: now() });
      log('system', 'obligation_repaid', { userId, obligationId: o.id, withdrawalId: o.withdrawalId ?? undefined, amountMicro: take, data: { leftMicro: o.amountMicro - o.repaidMicro, fully: o.status === 'repaid' } });
      held += take;
      firstId ||= o.id;
      if (!reasons.includes(o.publicReason)) reasons.push(o.publicReason);
    }
    if (held) {
      const d = { id: deductionId++, amountMicro: held, reason: reasons.join('; '), createdAt: now(), userId };
      deductions.push(d);
      ctx.notify(userId, 'obligation_repaid', null, { deduction: { ...d, reason: cap(d.reason) } });
    }
  };
  const credit = (userId: number, micro: number) => {
    user(userId).availableMicro += micro;
    settle(userId);
  };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  const createObligation = (req: CreateObligationRequest, actor: AuditActor = 'admin'): Obligation => {
    const amountMicro = Math.round(Number(req.amountUsdt) * USDT_MICRO);
    if (!(amountMicro > 0)) fail(400, 'Укажите сумму в USDT');
    const u = user(Number(req.userId));
    const o: Obligation = {
      id: obligationId++, userId: u.id, amountMicro, repaidMicro: 0, status: 'active',
      publicReason: (req.publicReason ?? '').trim() || DEFAULT_REASON, comment: (req.comment ?? '').trim() || null,
      withdrawalId: req.withdrawalId ?? null, createdAt: now(), repaidAt: null, writtenOffAt: null, writeOffComment: null, repayments: [],
    };
    obligations.push(o);
    log(actor, 'obligation_created', { userId: u.id, obligationId: o.id, withdrawalId: o.withdrawalId ?? undefined, amountMicro, data: { comment: o.comment } });
    settle(u.id);
    return o;
  };
  const obligationDto = (o: Obligation): AdminObligationDto => {
    const u = user(o.userId);
    return { ...o, repayments: [...o.repayments], user: { id: u.id, username: u.username, firstName: u.firstName, telegramId: u.telegramId } };
  };
  const leftFor = (userId: number) => obligations.filter((o) => o.userId === userId && o.status === 'active').reduce((a, o) => a + o.amountMicro - o.repaidMicro, 0);

  // ---------- views ----------

  const destination = (d: Deal) =>
    d.method === 'sbp' ? `${formatRuPhone(d.phone ?? '')} · ${d.bankName}` : `${CARD_BRAND_LABEL[cardBrand(d.cardNumber ?? '')] || 'Карта'} ${maskCard(d.cardNumber ?? '')}`;
  const requisite = (d: Deal) => (d.method === 'sbp' ? `${formatRuPhone(d.phone ?? '')} (${d.bankName})` : formatCard(d.cardNumber ?? ''));

  const userDto = (d: Deal): WithdrawalDto => {
    const u = user(d.userId);
    return {
      id: d.id, method: d.method, status: d.status, amountRub: d.amountRub, amountMicro: d.amountMicro, rate: d.rate,
      destination: destination(d), createdAt: d.createdAt, enteredAt: d.enteredAt,
      actions: u.supportLockedAt ? [] : userActions({ status: d.status, enteredAt: d.enteredAt }, now()),
      userDecision: d.userDecision, reportedRub: d.reportedRub, finalRub: d.finalRub, debitedMicro: d.debitedMicro,
      refundedMicro: d.refundedMicro, finishedAt: d.finishedAt, resolution: d.resolution, serverNow: now(),
    };
  };

  const listItem = (d: Deal): AdminWithdrawalListItem => {
    const u = user(d.userId);
    return {
      id: d.id, status: d.status, section: boardSection({ status: d.status, requisiteOffAt: d.requisiteOffAt }), method: d.method,
      amountRub: d.amountRub, amountMicro: d.amountMicro, destination: destination(d), requisite: requisite(d), bankId: d.bankId,
      bankName: d.bankName, createdAt: d.createdAt, takenAt: d.takenAt, enteredAt: d.enteredAt, requisiteOffAt: d.requisiteOffAt,
      remindersSent: d.remindersSent,
      nextReminderAt: d.status === 'entered' && d.enteredAt ? nextReminderAt(d.enteredAt, d.remindersSent) : null,
      inactiveAt: d.status === 'entered' && d.enteredAt ? d.enteredAt + INACTIVE_AFTER_MS : null,
      platformDeadline: d.enteredAt && !d.finishedAt ? d.enteredAt + PLATFORM_TIMER_MS : null,
      userDecision: d.userDecision, userDecidedAt: d.userDecidedAt, reportedRub: d.reportedRub, externalId: d.externalId,
      resolution: d.resolution, finalRub: d.finalRub, finishedAt: d.finishedAt,
      user: { id: u.id, username: u.username, firstName: u.firstName, telegramId: u.telegramId, supportLocked: !!u.supportLockedAt, botBlocked: !!u.botBlockedAt },
    };
  };

  const adminUser = (id: number): AdminUserDto => {
    const u = user(id);
    const mine = deals.filter((d) => d.userId === id);
    const done = mine.filter((d) => d.status === 'completed');
    return {
      id: u.id, telegramId: u.telegramId, username: u.username, firstName: u.firstName, lastName: u.lastName, photoUrl: null,
      languageCode: u.languageCode, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, blocked: u.blocked,
      missedConfirmations: u.missedConfirmations, supportLockedAt: u.supportLockedAt, botBlockedAt: u.botBlockedAt,
      obligationsLeftMicro: leftFor(id), availableMicro: u.availableMicro, frozenMicro: u.frozenMicro, depositAddresses: u.addresses,
      stats: {
        depositedMicro: u.depositedMicro,
        withdrawnRub: done.reduce((s, d) => s + (d.finalRub ?? d.amountRub), 0),
        withdrawnMicro: done.reduce((s, d) => s + (d.debitedMicro ?? d.amountMicro), 0),
        withdrawalsTotal: mine.length,
        withdrawalsCompleted: done.length,
        disputes: new Set(audit.filter((e) => e.userId === id && e.type === 'user_not_received').map((e) => e.withdrawalId)).size,
        transfersInMicro: ctx.transfersIn(id),
        transfersOutMicro: ctx.transfersOut(id),
        activeChecksMicro: ctx.activeChecks(id),
      },
    };
  };

  const adminGet = (id: number): AdminWithdrawalDto => {
    const d = deal(id);
    const u = user(d.userId);
    const same = new Map<number, number>();
    for (const o of deals) {
      if (o.userId === d.userId) continue;
      if ((d.phone && o.phone === d.phone) || (d.cardNumber && o.cardNumber === d.cardNumber)) same.set(o.userId, (same.get(o.userId) ?? 0) + 1);
    }
    return {
      ...listItem(d),
      phone: d.phone, cardNumber: d.cardNumber, cardBrand: d.cardNumber ? CARD_BRAND_LABEL[cardBrand(d.cardNumber)] : null,
      rate: d.rate, exchangeRate: d.exchangeRate, balanceBeforeMicro: d.balanceBeforeMicro, debitedMicro: d.debitedMicro,
      refundedMicro: d.refundedMicro, userConfirmedAt: d.userConfirmedAt, inactiveSince: d.inactiveSince,
      correction: d.status === 'mismatch' && d.reportedRub ? { reportedRub: d.reportedRub, ...correctionPlan(d.amountMicro, d.rate, d.reportedRub, u.availableMicro) } : null,
      clientIp: '185.12.64.7 (демо)', userAgent: 'Telegram iOS 11.2 (демо)', platform: d.platform,
      reminders: d.reminders.map((r) => ({ ...r })),
      events: audit.filter((e) => e.withdrawalId === id),
      userDetails: adminUser(d.userId),
      sameDestinationUsers: [...same].map(([uid, n]) => {
        const x = user(uid);
        return { id: x.id, username: x.username, firstName: x.firstName, withdrawals: n };
      }),
      recentWithdrawals: deals.filter((o) => o.userId === d.userId && o.id !== d.id).slice().reverse().slice(0, 10).map(listItem),
      obligations: obligations.filter((o) => o.userId === d.userId).map(obligationDto),
      serverNow: now(),
    };
  };

  // ---------- user side ----------

  const contactLock = (userId: number) => {
    const u = user(userId);
    return u.supportLockedAt ? { since: u.supportLockedAt } : null;
  };
  const assertNotLocked = (userId: number) => {
    if (contactLock(userId)) fail(423, 'Действие недоступно. Свяжитесь с поддержкой');
  };

  const create = (u: DemoUser, req: CreateWithdrawalRequest): Deal => {
    const dup = deals.find((d) => d.userId === u.id && d.requestId === req.requestId);
    if (dup) return dup;
    if (u.blocked) fail(403, 'Вывод недоступен. Свяжитесь с поддержкой');
    assertNotLocked(u.id);
    const err = validatePayoutRub(req.amountRub);
    if (err) fail(400, err);
    if (req.method === 'sbp') {
      const e = validateRuPhone(req.phone ?? '');
      if (e) fail(400, e);
      if (!findBank(req.bankId ?? '')) fail(400, 'Выберите банк');
    } else {
      const e = validateCard(req.cardNumber ?? '');
      if (e) fail(400, e);
    }
    const rate = ctx.walletRate();
    const amountMicro = usdtMicroForRub(req.amountRub, rate);
    if (amountMicro > u.availableMicro) fail(400, 'Недостаточно средств');
    const d = addDeal(u, {
      requestId: req.requestId, method: req.method, amountRub: req.amountRub, amountMicro, rate,
      phone: req.method === 'sbp' ? normalizeRuPhone(req.phone!) : null,
      bankId: req.method === 'sbp' ? req.bankId! : null,
      bankName: req.method === 'sbp' ? findBank(req.bankId!)!.name : null,
      cardNumber: req.method === 'card' ? req.cardNumber!.replace(/\D/g, '') : null,
      createdAt: now(),
    });
    return d;
  };

  const addDeal = (u: DemoUser, p: Pick<Deal, 'requestId' | 'method' | 'amountRub' | 'amountMicro' | 'rate' | 'phone' | 'bankId' | 'bankName' | 'cardNumber' | 'createdAt'>): Deal => {
    const d: Deal = {
      ...p, id: ++dealId, userId: u.id, exchangeRate: Math.round((p.rate / 1.05) * 100) / 100, balanceBeforeMicro: u.availableMicro,
      status: 'new', takenAt: null, enteredAt: null, requisiteOffAt: null, remindersSent: 0, reminders: [], inactiveSince: null,
      userDecision: null, userDecidedAt: null, reportedRub: null, userConfirmedAt: null, finalRub: null, debitedMicro: null,
      refundedMicro: null, resolution: null, externalId: null, finishedAt: null, platform: 'ios',
    };
    u.availableMicro -= d.amountMicro;
    u.frozenMicro += d.amountMicro;
    deals.push(d);
    log('user', 'deal_created', { userId: u.id, withdrawalId: d.id, amountMicro: d.amountMicro, amountRub: d.amountRub, data: { rate: d.rate }, at: d.createdAt });
    return d;
  };

  const guard = (userId: number, id: number, action: UserDealAction) => {
    assertNotLocked(userId);
    const d = deal(id);
    if (d.userId !== userId) fail(404, 'Заявка не найдена');
    if (!userCan({ status: d.status, enteredAt: d.enteredAt }, action, now())) {
      fail(409, d.status === 'user_confirmed' || d.status === 'completed' ? 'Сделка уже завершена' : 'Сейчас это действие недоступно');
    }
    return d;
  };

  const userReceived = (userId: number, id: number) => {
    const d = guard(userId, id, 'received');
    const from = d.status;
    Object.assign(d, { status: 'user_confirmed', userDecision: 'received', userDecidedAt: now(), userConfirmedAt: now(), debitedMicro: d.amountMicro, finalRub: d.amountRub });
    user(userId).frozenMicro -= d.amountMicro;
    log('user', 'user_received', { userId, withdrawalId: id, amountMicro: d.amountMicro, amountRub: d.amountRub, data: { from } });
    return d;
  };
  const userNotReceived = (userId: number, id: number) => {
    const d = guard(userId, id, 'not_received');
    Object.assign(d, { status: 'not_received', userDecision: 'not_received', userDecidedAt: now(), reportedRub: null });
    log('user', 'user_not_received', { userId, withdrawalId: id, amountRub: d.amountRub });
    return d;
  };
  const userOtherAmount = (userId: number, id: number, rub: number) => {
    const e = validateReportedRub(rub);
    if (e) fail(400, e);
    const d = guard(userId, id, 'other_amount');
    Object.assign(d, { status: 'mismatch', userDecision: 'other_amount', userDecidedAt: now(), reportedRub: rub });
    log('user', 'user_other_amount', { userId, withdrawalId: id, amountRub: rub, data: { originalRub: d.amountRub } });
    return d;
  };

  // ---------- operator side ----------

  const finish = (d: Deal, status: 'completed' | 'cancelled', resolution: DealResolution, externalId: string | undefined, fields: Partial<Deal>) => {
    const ext = (externalId ?? '').trim();
    Object.assign(d, fields, { status, resolution, finishedAt: now() }, ext ? { externalId: ext } : {});
    if (ext) log('admin', 'external_id_set', { userId: d.userId, withdrawalId: d.id, data: { externalId: ext } });
  };
  const tell = (d: Deal, type: NotificationType) => ctx.notify(d.userId, type, d.id);

  const dealAction = (id: number, path: DealActionPath, body: Record<string, unknown>) => {
    const d = deal(id);
    const ext = typeof body.externalId === 'string' ? body.externalId : undefined;
    if (path === 'note') {
      const text = String(body.text ?? '').trim();
      if (!text) fail(400, 'Пустая заметка');
      log('admin', 'note', { userId: d.userId, withdrawalId: id, data: { text } });
      return adminGet(id);
    }
    if (path === 'external-id') {
      d.externalId = String(body.externalId ?? '').trim() || null;
      log('admin', 'external_id_set', { userId: d.userId, withdrawalId: id, data: { externalId: d.externalId } });
      return adminGet(id);
    }
    const action = PATH_ACTION[path]!;
    if (!adminCan(d.status, action)) fail(409, `Действие недоступно: сделка в статусе «${ADMIN_STATUS_LABEL[d.status]}»`);
    const u = user(d.userId);
    switch (action) {
      case 'take':
        Object.assign(d, { status: 'in_work', takenAt: now() });
        log('admin', 'deal_taken', { userId: u.id, withdrawalId: id });
        break;
      case 'entered':
        Object.assign(d, { status: 'entered', enteredAt: now(), remindersSent: 0, requisiteOffAt: null });
        log('admin', 'deal_entered', { userId: u.id, withdrawalId: id, data: { requisite: requisite(d) } });
        break;
      case 'requisite_off':
        if (!d.requisiteOffAt) {
          d.requisiteOffAt = now();
          log('admin', 'requisite_off', { userId: u.id, withdrawalId: id, data: { requisite: requisite(d) } });
        }
        break;
      case 'confirm':
      case 'accept_original':
        finish(d, 'completed', action === 'confirm' ? 'confirmed_admin' : 'original', ext, { finalRub: d.amountRub, debitedMicro: d.amountMicro });
        u.frozenMicro -= d.amountMicro;
        log('admin', action === 'confirm' ? 'admin_confirmed' : 'original_accepted', { userId: u.id, withdrawalId: id, amountMicro: d.amountMicro, amountRub: d.amountRub });
        tell(d, 'deal_completed');
        break;
      case 'close':
        finish(d, 'completed', 'closed', ext, {});
        log('admin', 'deal_closed', { userId: u.id, withdrawalId: id });
        break;
      case 'reopen':
        Object.assign(d, { status: 'not_received', userDecision: null, userConfirmedAt: null, debitedMicro: null, finalRub: null });
        u.frozenMicro += d.amountMicro;
        log('admin', 'deal_reopened', { userId: u.id, withdrawalId: id, amountMicro: d.amountMicro });
        tell(d, 'deal_reminder');
        break;
      case 'accept_correction': {
        const plan = correctionPlan(d.amountMicro, d.rate, d.reportedRub!, u.availableMicro);
        const fromFrozen = Math.min(plan.correctedMicro, d.amountMicro);
        u.frozenMicro -= d.amountMicro;
        u.availableMicro -= plan.fromAvailableMicro;
        finish(d, 'completed', 'correction', ext, { finalRub: d.reportedRub, debitedMicro: fromFrozen + plan.fromAvailableMicro, refundedMicro: plan.refundMicro });
        log('admin', 'correction_accepted', { userId: u.id, withdrawalId: id, amountMicro: fromFrozen + plan.fromAvailableMicro, amountRub: d.reportedRub!, data: { ...plan } });
        if (plan.refundMicro) credit(u.id, plan.refundMicro);
        if (plan.shortageMicro > 0 && body.createObligation === true) {
          createObligation({ userId: u.id, amountUsdt: plan.shortageMicro / USDT_MICRO, withdrawalId: id, comment: `Корректировка по заявке №${id}` });
        }
        tell(d, 'deal_corrected');
        break;
      }
      case 'cancel':
        finish(d, 'cancelled', 'cancelled', ext, { refundedMicro: d.amountMicro });
        u.frozenMicro -= d.amountMicro;
        log('admin', 'deal_cancelled', { userId: u.id, withdrawalId: id, amountMicro: d.amountMicro, amountRub: d.amountRub, data: { reason: body.reason || null } });
        credit(u.id, d.amountMicro);
        tell(d, 'deal_cancelled');
        break;
    }
    return adminGet(id);
  };

  /** Reminders and inactivity, like the server timer. */
  const tick = () => {
    const t = now();
    for (const d of deals) {
      if (d.status !== 'entered' || !d.enteredAt) continue;
      if (t >= d.enteredAt + INACTIVE_AFTER_MS) {
        Object.assign(d, { status: 'inactive', inactiveSince: t });
        user(d.userId).missedConfirmations++;
        log('system', 'deal_inactive', { userId: d.userId, withdrawalId: d.id });
        continue;
      }
      const due = remindersDue(d.enteredAt, t);
      if (due > d.remindersSent) {
        d.remindersSent = due;
        const delivered = !user(d.userId).botBlockedAt;
        d.reminders.push({ n: due, at: t, delivered, error: delivered ? null : 'Пользователь заблокировал бота' });
        log('system', 'reminder_sent', { userId: d.userId, withdrawalId: d.id, data: { n: due, delivered } });
        ctx.notify(d.userId, 'deal_reminder', d.id);
      }
    }
  };
  setInterval(tick, 1000);

  // ---------- admin api parts ----------

  const board = (): AdminBoardDto => {
    tick();
    const items = deals.filter((d) => ACTIVE_STATUSES.includes(d.status)).sort((a, b) => a.createdAt - b.createdAt).map(listItem);
    const counts = Object.fromEntries(BOARD_SECTIONS.map((s) => [s.id, 0])) as Record<BoardSection, number>;
    for (const i of items) if (i.section) counts[i.section]++;
    return { items, counts, serverNow: now() };
  };

  const archive = (q: ArchiveQuery) => {
    const text = (q.q ?? '').trim().toLowerCase().replace(/^@/, '');
    const digits = text.replace(/[\s№#+()-]/g, '');
    const items = deals
      .filter((d) => d.status === 'completed' || d.status === 'cancelled')
      .filter((d) => !q.resolution || d.resolution === q.resolution)
      .filter((d) => !q.method || d.method === q.method)
      .filter((d) => !q.from || d.createdAt >= Number(q.from))
      .filter((d) => !q.to || d.createdAt <= Number(q.to))
      .filter((d) => {
        if (!text) return true;
        const u = user(d.userId);
        return (
          (d.externalId ?? '').toLowerCase().includes(text) || (u.username ?? '').toLowerCase().includes(text) || u.firstName.toLowerCase().includes(text) ||
          (/^\d+$/.test(digits) && (String(d.id) === digits || String(d.amountRub) === digits || String(d.finalRub) === digits || (d.phone ?? '').includes(digits) || (d.cardNumber ?? '').includes(digits)))
        );
      })
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(Number(q.offset) || 0, (Number(q.offset) || 0) + 100)
      .map(listItem);
    return { items };
  };

  const usersList = (q: string): { items: AdminUserListItem[] } => {
    const t = q.trim().toLowerCase().replace(/^@/, '');
    return {
      items: ctx.users
        .filter((u) => !t || (u.username ?? '').toLowerCase().includes(t) || u.firstName.toLowerCase().includes(t) || String(u.telegramId) === t)
        .map((u) => ({
          id: u.id, telegramId: u.telegramId, username: u.username, firstName: u.firstName, lastName: u.lastName, createdAt: u.createdAt,
          lastSeenAt: u.lastSeenAt, availableMicro: u.availableMicro, frozenMicro: u.frozenMicro, supportLocked: !!u.supportLockedAt,
          blocked: u.blocked, activeDeals: deals.filter((d) => d.userId === u.id && ACTIVE_STATUSES.includes(d.status)).length,
          obligationsLeftMicro: leftFor(u.id),
        })),
    };
  };

  const userPage = (id: number): AdminUserPageDto => ({
    ...adminUser(id),
    deals: deals.filter((d) => d.userId === id).slice().reverse().map(listItem),
    obligations: obligations.filter((o) => o.userId === id).map(obligationDto),
  });

  const journal = (q: JournalQuery) => {
    const types = (q.types ?? '').split(',').filter(Boolean);
    const t = (q.q ?? '').trim().toLowerCase().replace(/^@/, '');
    return {
      items: audit
        .filter((e) => !types.length || types.includes(e.type))
        .filter((e) => !q.userId || e.userId === Number(q.userId))
        .filter((e) => !q.dealId || e.withdrawalId === Number(q.dealId))
        .filter((e) => !q.from || e.at >= Number(q.from))
        .filter((e) => !q.to || e.at <= Number(q.to))
        .filter((e) => !q.before || e.id < Number(q.before))
        .filter((e) => !t || (e.username ?? '').toLowerCase().includes(t) || (e.firstName ?? '').toLowerCase().includes(t) || JSON.stringify(e.data ?? {}).toLowerCase().includes(t))
        .slice()
        .sort((a, b) => b.at - a.at || b.id - a.id)
        .slice(0, 100),
    };
  };

  const setSupportLock = (id: number, locked: boolean) => {
    const u = user(id);
    if (!!u.supportLockedAt !== locked) {
      u.supportLockedAt = locked ? now() : null;
      log('admin', locked ? 'support_lock' : 'support_unlock', { userId: id });
      ctx.notify(id, 'support_lock', null);
    }
    return userPage(id);
  };
  const setBlocked = (id: number, blocked: boolean) => {
    user(id).blocked = blocked;
    log('admin', blocked ? 'user_blocked' : 'user_unblocked', { userId: id });
    return userPage(id);
  };
  const adjust = (id: number, amountUsdt: number, comment: string) => {
    if (!comment.trim()) fail(400, 'Укажите причину корректировки');
    const micro = Math.round(amountUsdt * USDT_MICRO);
    if (!micro) fail(400, 'Укажите сумму');
    const u = user(id);
    if (u.availableMicro + micro < 0) fail(400, 'Баланс не может стать отрицательным');
    log('admin', 'manual_adjustment', { userId: id, amountMicro: micro, data: { comment } });
    if (micro > 0) credit(id, micro);
    else u.availableMicro += micro;
    return userPage(id);
  };

  const broadcastSend = (req: BroadcastRequest): AdminBroadcastDto => {
    if (!req.text?.trim() && !req.photoBase64) fail(400, 'Напишите текст сообщения');
    const total = ctx.users.length;
    const blocked = ctx.users.filter((u) => u.botBlockedAt).length;
    const b: AdminBroadcastDto = {
      id: broadcasts.length + 1, createdAt: now(), author: 'admin', text: req.text.trim(), hasPhoto: !!req.photoBase64,
      buttonText: req.buttonText ?? null, buttonUrl: req.buttonUrl ?? null, status: 'sending', total, sent: 0, failed: 0, blocked: 0, finishedAt: null, errors: [],
    };
    broadcasts.unshift(b);
    log('admin', 'broadcast_sent', { data: { recipients: total, text: b.text.slice(0, 200) } });
    setTimeout(() => Object.assign(b, { status: 'done', sent: total - blocked, blocked, finishedAt: now() }), 2500);
    return b;
  };

  return {
    now,
    warp: (ms: number) => {
      warp += ms;
      tick();
    },
    deals,
    addDeal,
    deal,
    userDto,
    create,
    userReceived,
    userNotReceived,
    userOtherAmount,
    contactLock,
    assertNotLocked,
    credit,
    settle,
    log,
    deductionsFor: (userId: number): DeductionDto[] => deductions.filter((d) => d.userId === userId).map(({ userId: _u, ...d }) => ({ ...d, reason: cap(d.reason) })),
    adminUser,
    createObligation,
    obligations,
    broadcasts,
    admin: {
      board,
      archive,
      deal: adminGet,
      dealAction,
      users: usersList,
      user: userPage,
      adjust,
      setBlocked,
      setSupportLock,
      obligationsList: (f: { status?: string; userId?: number }) => ({
        items: obligations
          .filter((o) => !f.status || o.status === f.status)
          .filter((o) => !f.userId || o.userId === f.userId)
          .slice()
          .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.id - a.id)
          .map(obligationDto),
      }),
      createObligation: (req: CreateObligationRequest) => obligationDto(createObligation(req)),
      writeOff: (id: number, comment: string) => {
        const o = obligations.find((x) => x.id === id) ?? fail(404, 'Обязательство не найдено');
        if (o.status !== 'active') fail(409, 'Обязательство уже закрыто');
        Object.assign(o, { status: 'written_off', writtenOffAt: now(), writeOffComment: comment || 'списано' });
        log('admin', 'obligation_written_off', { userId: o.userId, obligationId: o.id, amountMicro: o.amountMicro - o.repaidMicro, data: { comment } });
        return obligationDto(o);
      },
      journal,
      broadcasts: () => ({ items: broadcasts.map((b) => ({ ...b })) }),
      broadcastTest: (req: BroadcastRequest) => {
        if (!req.text?.trim() && !req.photoBase64) fail(400, 'Напишите текст сообщения');
        return { ok: true, error: null };
      },
      broadcastSend,
    },
  };
}

export type DealEngine = ReturnType<typeof createDealEngine>;
export const DEMO_MIN = MIN;
export const DEMO_REMINDER = REMINDER_INTERVAL_MS;
