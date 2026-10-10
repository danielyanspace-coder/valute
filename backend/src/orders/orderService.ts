import type {
  AdminOrderCounts,
  AdminOrderDto,
  AdminOrderListItem,
  CreateOrderRequest,
  ServiceOrderDto,
  WithdrawalEventDto,
} from '../../../shared/api.js';
import { parseUsdt } from '../../../shared/transfers.js';
import {
  MAX_FINE_RUB,
  MIN_FINE_RUB,
  ORDER_STATUS_LABEL,
  SERVICE_TITLE,
  fineDueRub,
  formatParkingPhone,
  nextOrderStatus,
  normalizeParkingPhone,
  normalizeUin,
  rubForServiceMicro,
  serviceMicroForRub,
  serviceRate,
  validateParkingAmount,
  validateParkingPhone,
  validateSteamLogin,
  validateSteamRub,
  validateUin,
  type FineInfo,
  type OrderAction,
  type OrderStatus,
  type ServiceKind,
} from '../../../shared/services.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import { em, esc } from '../notifications/emoji.js';
import type { UserRepo, UserRow } from '../users/userRepo.js';
import { AppError, type RequestContext, type WithdrawalService } from '../withdrawals/withdrawalService.js';
import type { FineLookup } from './fineLookup.js';

export interface OrderRow {
  id: number;
  user_id: number;
  request_id: string;
  kind: ServiceKind;
  status: OrderStatus;
  amount_rub: number;
  amount_micro: number;
  rate: number;
  exchange_rate: number;
  discount_percent: number;
  uin: string | null;
  fine_json: string | null;
  amount_source: 'provider' | 'user' | null;
  phone: string | null;
  steam_login: string | null;
  clarify_message: string | null;
  reject_reason: string | null;
  balance_before_micro: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  client_ip: string | null;
  platform: string | null;
}

type Actor = 'user' | 'admin' | 'system';

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

/**
 * Service orders ("МК"): the user pays USDT at the Rapira price minus the discount,
 * the USDT are frozen, the operator pays the merchant by hand and marks the order.
 */
export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly ledger: Ledger,
    private readonly notifications: NotificationService,
    private readonly withdrawals: WithdrawalService,
    private readonly fines: FineLookup,
    private readonly discountPercent: number,
    private readonly now: () => number = Date.now,
  ) {}

  rateFor(exchangeRate: number): number {
    return serviceRate(exchangeRate, this.discountPercent);
  }

  async lookupFine(uinInput: string): Promise<FineInfo | null> {
    const err = validateUin(uinInput);
    if (err) throw new AppError(400, 'uin', err);
    if (!this.fines.available) throw new AppError(501, 'lookup_unavailable', 'Автоматический поиск штрафа пока недоступен');
    return this.fines.lookup(normalizeUin(uinInput));
  }

  async create(user: UserRow, req: CreateOrderRequest, exchangeRate: number | null, ctx: RequestContext & { platform?: string } = {}): Promise<OrderRow> {
    if (user.blocked) throw new AppError(403, 'blocked', 'Операции недоступны. Свяжитесь с поддержкой');
    this.withdrawals.assertNotLocked(user.id);
    if (req.acceptedTerms !== true) throw new AppError(400, 'terms', 'Нужно подтвердить условия');
    if (!req.requestId || req.requestId.length > 64) throw new AppError(400, 'request_id', 'Некорректный запрос');
    const existing = this.db
      .prepare('SELECT * FROM service_orders WHERE user_id = ? AND request_id = ?')
      .get(user.id, req.requestId) as unknown as OrderRow | undefined;
    if (existing) return existing;
    if (!exchangeRate) throw new AppError(503, 'rate_unavailable', 'Курс временно недоступен, попробуйте через минуту');

    const rate = this.rateFor(exchangeRate);
    const fields: Partial<OrderRow> = {};
    let amountRub: number;
    let amountMicro: number;

    switch (req.kind) {
      case 'fine': {
        const uinErr = validateUin(req.uin ?? '');
        if (uinErr) throw new AppError(400, 'uin', uinErr);
        fields.uin = normalizeUin(req.uin!);
        if (this.fines.available) {
          // Never trust the client with the amount: look the fine up again.
          const fine = await this.fines.lookup(fields.uin);
          if (!fine) throw new AppError(404, 'fine_not_found', 'Штраф с таким УИН не найден или уже оплачен');
          amountRub = fineDueRub(fine);
          fields.fine_json = JSON.stringify(fine);
          fields.amount_source = 'provider';
        } else {
          amountRub = Number(req.amountRub);
          if (!Number.isInteger(amountRub) || amountRub < MIN_FINE_RUB || amountRub > MAX_FINE_RUB) {
            throw new AppError(400, 'amount', 'Введите сумму штрафа в рублях, как в постановлении');
          }
          fields.amount_source = 'user';
        }
        amountMicro = serviceMicroForRub(amountRub, rate);
        break;
      }
      case 'parking': {
        const phoneErr = validateParkingPhone(req.phone ?? '');
        if (phoneErr) throw new AppError(400, 'phone', phoneErr);
        amountRub = Number(req.amountRub);
        const amountErr = validateParkingAmount(amountRub);
        if (amountErr) throw new AppError(400, 'amount', amountErr);
        fields.phone = normalizeParkingPhone(req.phone!);
        amountMicro = serviceMicroForRub(amountRub, rate);
        break;
      }
      case 'steam': {
        const loginErr = validateSteamLogin(req.steamLogin ?? '');
        if (loginErr) throw new AppError(400, 'login', loginErr);
        const micro = parseUsdt(req.amountUsdt ?? '');
        if (typeof micro === 'string') throw new AppError(400, 'amount', micro);
        amountMicro = micro;
        amountRub = rubForServiceMicro(micro, rate);
        const rubErr = validateSteamRub(amountRub);
        if (rubErr) throw new AppError(400, 'amount', rubErr);
        fields.steam_login = req.steamLogin!.trim();
        break;
      }
      default:
        throw new AppError(400, 'kind', 'Неизвестный сервис');
    }

    return transaction(this.db, () => {
      const { availableMicro } = this.ledger.balances(user.id);
      if (availableMicro < amountMicro) throw new AppError(400, 'insufficient', 'Недостаточно средств');
      const now = this.now();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO service_orders (user_id, request_id, kind, status, amount_rub, amount_micro, rate, exchange_rate,
             discount_percent, uin, fine_json, amount_source, phone, steam_login, balance_before_micro, created_at, updated_at,
             client_ip, platform)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          user.id, req.requestId, req.kind, amountRub, amountMicro, rate, exchangeRate, this.discountPercent,
          fields.uin ?? null, fields.fine_json ?? null, fields.amount_source ?? null, fields.phone ?? null,
          fields.steam_login ?? null, availableMicro, now, now, ctx.ip ?? null, ctx.platform?.slice(0, 40) ?? null,
        );
      const id = Number(lastInsertRowid);
      this.ledger.post([
        { userId: user.id, bucket: 'available', amountMicro: -amountMicro, kind: 'order_freeze', refType: 'order', refId: id },
        { userId: user.id, bucket: 'frozen', amountMicro, kind: 'order_freeze', refType: 'order', refId: id },
      ]);
      this.event(id, 'user', 'created', { amountRub, amountMicro, rate });
      return this.row(id)!;
    });
  }

  listForUser(userId: number, limit = 50): OrderRow[] {
    return this.db
      .prepare('SELECT * FROM service_orders WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit) as unknown as OrderRow[];
  }

  getForUser(userId: number, id: number): OrderRow {
    const o = this.row(id);
    if (!o || o.user_id !== userId) throw new AppError(404, 'not_found', 'Заявка не найдена');
    return o;
  }

  // ---------- Admin ----------

  markPaid(id: number): OrderRow {
    return this.finish(id, 'paid', (o) => {
      this.ledger.post([
        { userId: o.user_id, bucket: 'frozen', amountMicro: -o.amount_micro, kind: 'order_payout', refType: 'order', refId: id },
      ]);
      this.event(id, 'admin', 'paid', {});
      this.notify(o, 'order_paid', `${em('success')} <b>${SERVICE_TITLE[o.kind]}</b>: заявка #${o.id} на ${rub(o.amount_rub)} оплачена.`);
    });
  }

  reject(id: number, reason: string): OrderRow {
    const text = reason.trim().slice(0, 500);
    if (!text) throw new AppError(400, 'reason', 'Укажите причину отклонения');
    return this.finish(id, 'reject', (o) => {
      this.db.prepare('UPDATE service_orders SET reject_reason = ? WHERE id = ?').run(text, id);
      this.ledger.post([
        { userId: o.user_id, bucket: 'frozen', amountMicro: -o.amount_micro, kind: 'order_refund', refType: 'order', refId: id },
        { userId: o.user_id, bucket: 'available', amountMicro: o.amount_micro, kind: 'order_refund', refType: 'order', refId: id },
      ]);
      this.event(id, 'admin', 'rejected', { reason: text });
      this.notify(o, 'order_rejected', `${em('cancel')} <b>${SERVICE_TITLE[o.kind]}</b>: заявка #${o.id} отклонена.\nПричина: ${esc(text)}\n${em('received')} USDT вернулись на баланс.`);
    });
  }

  /** Ask the user for details; USDT stay frozen. */
  clarify(id: number, message: string): OrderRow {
    const text = message.trim().slice(0, 1000);
    if (!text) throw new AppError(400, 'message', 'Напишите, что нужно уточнить');
    return transaction(this.db, () => {
      const o = this.mustRow(id);
      this.transition(o, 'clarify', { clarify_message: text });
      this.event(id, 'admin', 'clarify', { message: text });
      this.notify(o, 'order_clarify', `${em('support')} <b>${SERVICE_TITLE[o.kind]}</b>: по заявке #${o.id} нужно уточнение.\n${esc(text)}`);
      return this.row(id)!;
    });
  }

  addNote(id: number, text: string): OrderRow {
    const note = text.trim().slice(0, 2000);
    if (!note) throw new AppError(400, 'note', 'Пустая заметка');
    this.mustRow(id);
    this.event(id, 'admin', 'note', { text: note });
    return this.row(id)!;
  }

  counts(): AdminOrderCounts {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM service_orders GROUP BY status').all() as unknown as {
      status: OrderStatus;
      n: number;
    }[];
    const c: AdminOrderCounts = { pending: 0, clarify: 0, paid: 0, rejected: 0 };
    for (const r of rows) c[r.status] = r.n;
    return c;
  }

  adminList(status: OrderStatus | 'all', limit = 200): AdminOrderListItem[] {
    const rows = (
      status === 'all'
        ? this.db.prepare('SELECT * FROM service_orders ORDER BY id DESC LIMIT ?').all(limit)
        : this.db.prepare('SELECT * FROM service_orders WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    ) as unknown as OrderRow[];
    return rows.map((o) => this.listItem(o));
  }

  adminGet(id: number): AdminOrderDto {
    const o = this.mustRow(id);
    const events = (
      this.db.prepare('SELECT * FROM service_order_events WHERE order_id = ? ORDER BY id').all(id) as unknown as {
        id: number;
        at: number;
        actor: Actor;
        type: string;
        data: string | null;
      }[]
    ).map((e): WithdrawalEventDto => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
    return {
      ...this.listItem(o),
      rate: o.rate,
      exchangeRate: o.exchange_rate,
      discountPercent: o.discount_percent,
      benefitRub: benefit(o),
      fine: o.fine_json ? (JSON.parse(o.fine_json) as FineInfo) : null,
      amountSource: o.amount_source,
      phone: o.phone,
      steamLogin: o.steam_login,
      clarifyMessage: o.clarify_message,
      rejectReason: o.reject_reason,
      finishedAt: o.finished_at,
      balanceBeforeMicro: o.balance_before_micro,
      clientIp: o.client_ip,
      platform: o.platform,
      events,
      userDetails: this.withdrawals.adminUser(o.user_id),
      serverNow: this.now(),
    };
  }

  toUserDto(o: OrderRow): ServiceOrderDto {
    return {
      id: o.id,
      kind: o.kind,
      status: o.status,
      amountRub: o.amount_rub,
      amountMicro: o.amount_micro,
      rate: o.rate,
      discountPercent: o.discount_percent,
      benefitRub: benefit(o),
      target: target(o),
      fine: o.fine_json ? (JSON.parse(o.fine_json) as FineInfo) : null,
      clarifyMessage: o.status === 'clarify' ? o.clarify_message : null,
      rejectReason: o.reject_reason,
      createdAt: o.created_at,
      finishedAt: o.finished_at,
    };
  }

  row(id: number): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM service_orders WHERE id = ?').get(id) as unknown as OrderRow | undefined;
  }

  // ---------- Internals ----------

  private finish(id: number, action: OrderAction, effects: (o: OrderRow) => void): OrderRow {
    return transaction(this.db, () => {
      const o = this.mustRow(id);
      this.transition(o, action, { finished_at: this.now() });
      effects(o);
      return this.row(id)!;
    });
  }

  private transition(o: OrderRow, action: OrderAction, fields: Partial<OrderRow>): void {
    const to = nextOrderStatus(o.status, action);
    if (!to) throw new AppError(409, 'bad_status', `Действие недоступно: заявка в статусе «${ORDER_STATUS_LABEL[o.status]}»`);
    const all = { ...fields, updated_at: this.now() } as Record<string, string | number | null>;
    const sets = Object.keys(all).map((k) => `${k} = :${k}`);
    const res = this.db
      .prepare(`UPDATE service_orders SET ${['status = :to', ...sets].join(', ')} WHERE id = :id AND status = :from`)
      .run({ ...all, to, id: o.id, from: o.status });
    if (res.changes !== 1) throw new AppError(409, 'conflict', 'Заявка уже изменилась, обновите страницу');
  }

  private notify(o: OrderRow, type: 'order_paid' | 'order_rejected' | 'order_clarify', text: string): void {
    this.notifications.notify(this.users.get(o.user_id)!, type, { orderId: o.id, botText: text });
  }

  private event(orderId: number, actor: Actor, type: string, data: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO service_order_events (order_id, at, actor, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(orderId, this.now(), actor, type, JSON.stringify(data));
  }

  private mustRow(id: number): OrderRow {
    const o = this.row(id);
    if (!o) throw new AppError(404, 'not_found', 'Заявка не найдена');
    return o;
  }

  private listItem(o: OrderRow): AdminOrderListItem {
    const u = this.users.get(o.user_id)!;
    return {
      id: o.id,
      kind: o.kind,
      status: o.status,
      amountRub: o.amount_rub,
      amountMicro: o.amount_micro,
      target: target(o),
      createdAt: o.created_at,
      user: { id: u.id, username: u.username, firstName: u.first_name, telegramId: u.telegram_id },
    };
  }
}

/** Rubles saved: what the order is worth minus what the paid USDT cost at the exchange price. */
function benefit(o: OrderRow): number {
  return Math.max(0, Math.round(o.amount_rub - (o.amount_micro / 1_000_000) * o.exchange_rate));
}

function target(o: OrderRow): string {
  if (o.kind === 'fine') return `УИН ${o.uin}`;
  if (o.kind === 'parking') return formatParkingPhone(o.phone ?? '');
  return `Логин ${o.steam_login}`;
}

