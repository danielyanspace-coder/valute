import type { AdminUsdtPayoutCounts, AdminUsdtPayoutDto, CreateUsdtPayoutRequest, UsdtPayoutDto } from '../../../shared/api.js';
import { parseUsdt, shortUsdt } from '../../../shared/transfers.js';
import { validateUsdtPayout, type UsdtPayoutStatus } from '../../../shared/usdtPayout.js';
import type { AmlService } from '../aml/amlService.js';
import type { AuditLog } from '../audit/auditLog.js';
import { isPremium } from '../premium/premiumService.js';
import { transaction, type Db } from '../db/database.js';
import type { TronChain } from '../deposits/tronClient.js';
import { isTronAddress } from '../deposits/tronHd.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import { em, esc } from '../notifications/emoji.js';
import type { UserRepo, UserRow } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';

export interface UsdtPayoutRow {
  id: number;
  user_id: number;
  request_id: string;
  address: string;
  amount_micro: number;
  fee_micro: number;
  status: UsdtPayoutStatus;
  aml_decision: string | null;
  aml_detail: string | null;
  tx_id: string | null;
  reject_reason: string | null;
  admin_note: string | null;
  balance_before_micro: number;
  created_at: number;
  finished_at: number | null;
  client_ip: string | null;
  priority: number;
}

export interface UsdtPayoutOptions {
  feeMicro: number;
  minMicro: number;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * USDT TRC-20 withdrawals. The user's amount plus the fee is frozen; the operator
 * sends the amount from their own wallet and enters the tx hash, which is checked on
 * the solidified chain (recipient, token, amount) before the request is closed.
 */
export class UsdtPayoutService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly users: UserRepo,
    private readonly notifications: NotificationService,
    private readonly aml: AmlService,
    private readonly chain: TronChain,
    readonly opts: UsdtPayoutOptions,
    private readonly audit?: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- user ----------

  async create(user: UserRow, req: CreateUsdtPayoutRequest, ctx: { ip?: string } = {}): Promise<UsdtPayoutRow> {
    if (user.blocked) throw new AppError(403, 'blocked', 'Вывод недоступен. Свяжитесь с поддержкой');
    if (req.acceptedTerms !== true) throw new AppError(400, 'terms', 'Нужно принять условия вывода');
    if (!req.requestId || req.requestId.length > 64) throw new AppError(400, 'request_id', 'Некорректный запрос');
    const dup = this.byRequest(user.id, req.requestId);
    if (dup) return dup;

    const address = String(req.address ?? '').trim();
    if (!isTronAddress(address)) throw new AppError(400, 'address', 'Это не адрес TRON. Он начинается на T и состоит из 34 символов');
    if (this.db.prepare('SELECT 1 FROM deposit_pool WHERE address = ?').get(address)) {
      throw new AppError(400, 'own_address', 'Это адрес пополнения Crypto IX. Укажите адрес своего кошелька или биржи');
    }
    const amount = parseUsdt(req.amount);
    if (typeof amount === 'string') throw new AppError(400, 'amount', amount);

    // The recipient is screened before any money moves: sending to a blacklisted address can get our wallet frozen.
    const aml = await this.aml.screen('TRON', address);
    if (aml.decision === 'reject') throw new AppError(400, 'aml', 'Вывод на этот адрес невозможен: он в чёрном списке Tether или санкционных списках');

    const row = transaction(this.db, () => {
      const again = this.byRequest(user.id, req.requestId);
      if (again) return again;
      const { availableMicro } = this.ledger.balances(user.id);
      const err = validateUsdtPayout(amount, availableMicro, this.opts.feeMicro, this.opts.minMicro);
      if (err) throw new AppError(400, 'amount', err);
      const total = amount + this.opts.feeMicro;
      const res = this.db
        .prepare(
          `INSERT INTO usdt_payouts (user_id, request_id, address, amount_micro, fee_micro, status, aml_decision, aml_detail, balance_before_micro, created_at, client_ip)
           VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
        )
        .run(user.id, req.requestId, address, amount, this.opts.feeMicro, aml.decision, JSON.stringify(aml.signals), availableMicro, this.now(), ctx.ip ?? null);
      const id = Number(res.lastInsertRowid);
      if (isPremium(this.db, user.id, this.now())) this.db.prepare('UPDATE usdt_payouts SET priority = 1 WHERE id = ?').run(id);
      this.ledger.post([
        { userId: user.id, bucket: 'available', amountMicro: -total, kind: 'usdt_payout_freeze', refType: 'usdt_payout', refId: id },
        { userId: user.id, bucket: 'frozen', amountMicro: total, kind: 'usdt_payout_freeze', refType: 'usdt_payout', refId: id },
      ]);
      this.audit?.log({ actor: 'user', type: 'usdt_payout_created', userId: user.id, amountMicro: amount, data: { payoutId: id, address, feeMicro: this.opts.feeMicro } });
      return this.get(id)!;
    });
    return row;
  }

  private byRequest(userId: number, requestId: string): UsdtPayoutRow | null {
    return (this.db.prepare('SELECT * FROM usdt_payouts WHERE user_id = ? AND request_id = ?').get(userId, requestId) as unknown as UsdtPayoutRow | undefined) ?? null;
  }

  get(id: number): UsdtPayoutRow | null {
    return (this.db.prepare('SELECT * FROM usdt_payouts WHERE id = ?').get(id) as unknown as UsdtPayoutRow | undefined) ?? null;
  }

  getForUser(userId: number, id: number): UsdtPayoutRow {
    const p = this.get(id);
    if (!p || p.user_id !== userId) throw new AppError(404, 'not_found', 'Заявка не найдена');
    return p;
  }

  listForUser(userId: number): UsdtPayoutRow[] {
    return this.db.prepare('SELECT * FROM usdt_payouts WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(userId) as unknown as UsdtPayoutRow[];
  }

  toUserDto(p: UsdtPayoutRow): UsdtPayoutDto {
    return {
      id: p.id,
      address: p.address,
      amountMicro: p.amount_micro,
      feeMicro: p.fee_micro,
      totalMicro: p.amount_micro + p.fee_micro,
      status: p.status,
      txId: p.tx_id,
      rejectReason: p.reject_reason,
      createdAt: p.created_at,
      finishedAt: p.finished_at,
    };
  }

  // ---------- admin ----------

  counts(): AdminUsdtPayoutCounts {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM usdt_payouts GROUP BY status').all() as unknown as { status: UsdtPayoutStatus; n: number }[];
    const get = (s: UsdtPayoutStatus) => rows.find((r) => r.status === s)?.n ?? 0;
    return { new: get('new'), sent: get('sent'), rejected: get('rejected') };
  }

  adminList(status: UsdtPayoutStatus | 'all'): AdminUsdtPayoutDto[] {
    const rows = (
      status === 'all'
        ? this.db.prepare('SELECT * FROM usdt_payouts ORDER BY id DESC LIMIT 200').all()
        : this.db.prepare(`SELECT * FROM usdt_payouts WHERE status = ? ORDER BY ${status === 'new' ? 'priority DESC, id ASC' : 'id DESC'} LIMIT 200`).all(status)
    ) as unknown as UsdtPayoutRow[];
    return rows.map((p) => this.toAdminDto(p));
  }

  toAdminDto(p: UsdtPayoutRow): AdminUsdtPayoutDto {
    const u = this.users.get(p.user_id);
    let signals: AdminUsdtPayoutDto['amlSignals'] = [];
    try {
      signals = p.aml_detail ? JSON.parse(p.aml_detail) : [];
    } catch {
      /* keep empty */
    }
    const before = this.db
      .prepare(`SELECT COUNT(*) AS n FROM usdt_payouts WHERE user_id = ? AND address = ? AND status = 'sent' AND id != ?`)
      .get(p.user_id, p.address, p.id) as { n: number };
    return {
      ...this.toUserDto(p),
      user: { id: p.user_id, username: u?.username ?? null, firstName: u?.first_name ?? `#${p.user_id}`, telegramId: u?.telegram_id ?? 0 },
      priority: !!p.priority,
      amlDecision: (p.aml_decision as AdminUsdtPayoutDto['amlDecision']) ?? null,
      amlSignals: signals,
      adminNote: p.admin_note,
      sameAddressBefore: Number(before.n),
      balanceBeforeMicro: p.balance_before_micro,
    };
  }

  /**
   * The operator sent the USDT. The hash is checked on the solidified chain unless
   * `force` (TronGrid down): it must move at least the amount of real USDT to the address.
   */
  async markSent(id: number, txIdRaw: string, force = false, note = ''): Promise<AdminUsdtPayoutDto> {
    const txId = txIdRaw.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(txId)) throw new AppError(400, 'tx', 'Хэш транзакции: 64 символа 0-9 и a-f. Скопируйте его из TronLink или Tronscan');
    const p = this.get(id);
    if (!p) throw new AppError(404, 'not_found', 'Заявка не найдена');
    if (p.status !== 'new') throw new AppError(409, 'state', 'Заявка уже обработана');
    const used = this.db.prepare('SELECT id FROM usdt_payouts WHERE tx_id = ?').get(txId) as { id: number } | undefined;
    if (used) throw new AppError(409, 'tx_used', `Этот хэш уже указан в заявке №${used.id}`);

    if (!force) {
      const v = await this.chain.verifyUsdtTo(txId, p.address);
      if (v.state === 'unconfirmed') throw new AppError(409, 'tx_unconfirmed', 'Транзакция ещё не подтверждена сетью. Подождите минуту и нажмите снова');
      if (v.state === 'failed') throw new AppError(409, 'tx_wrong', 'В этой транзакции нет перевода USDT на адрес клиента. Проверьте хэш');
      if (v.valueMicro < p.amount_micro) {
        throw new AppError(409, 'tx_amount', `Транзакция перевела ${shortUsdt(v.valueMicro)} USDT, а нужно ${shortUsdt(p.amount_micro)}. Проверьте хэш или дошлите разницу`);
      }
    }

    const row = transaction(this.db, () => {
      const res = this.db
        .prepare(`UPDATE usdt_payouts SET status = 'sent', tx_id = ?, finished_at = ?, admin_note = ? WHERE id = ? AND status = 'new'`)
        .run(txId, this.now(), note.trim().slice(0, 500) || (force ? 'без проверки в сети' : null), id);
      if (Number(res.changes) !== 1) throw new AppError(409, 'state', 'Заявка уже обработана');
      const total = p.amount_micro + p.fee_micro;
      this.ledger.post([{ userId: p.user_id, bucket: 'frozen', amountMicro: -total, kind: 'usdt_payout_sent', refType: 'usdt_payout', refId: id }]);
      this.audit?.log({ actor: 'admin', type: 'usdt_payout_sent', userId: p.user_id, amountMicro: p.amount_micro, data: { payoutId: id, txId, force } });
      return this.get(id)!;
    });
    const user = this.users.get(row.user_id);
    if (user) {
      this.notifications.notify(user, 'usdt_payout_sent', {
        usdtPayoutId: row.id,
        botText: `${em('success')} <b>Вывод ${shortUsdt(row.amount_micro)} USDT отправлен</b>\nАдрес: <code>${short(row.address)}</code>\n<a href="https://tronscan.org/#/transaction/${txId}">Открыть транзакцию в Tronscan</a>`,
      });
    }
    return this.toAdminDto(row);
  }

  reject(id: number, reasonRaw: string): AdminUsdtPayoutDto {
    const reason = reasonRaw.trim().slice(0, 300);
    if (!reason) throw new AppError(400, 'reason_required', 'Укажите причину, её увидит клиент');
    const row = transaction(this.db, () => {
      const p = this.get(id);
      if (!p) throw new AppError(404, 'not_found', 'Заявка не найдена');
      const res = this.db
        .prepare(`UPDATE usdt_payouts SET status = 'rejected', reject_reason = ?, finished_at = ? WHERE id = ? AND status = 'new'`)
        .run(reason, this.now(), id);
      if (Number(res.changes) !== 1) throw new AppError(409, 'state', 'Заявка уже обработана');
      const total = p.amount_micro + p.fee_micro;
      this.ledger.post([
        { userId: p.user_id, bucket: 'frozen', amountMicro: -total, kind: 'usdt_payout_rejected', refType: 'usdt_payout', refId: id },
        { userId: p.user_id, bucket: 'available', amountMicro: total, kind: 'usdt_payout_rejected', refType: 'usdt_payout', refId: id },
      ]);
      this.audit?.log({ actor: 'admin', type: 'usdt_payout_rejected', userId: p.user_id, amountMicro: p.amount_micro, data: { payoutId: id, reason } });
      return this.get(id)!;
    });
    const user = this.users.get(row.user_id);
    if (user) {
      this.notifications.notify(user, 'usdt_payout_rejected', {
        usdtPayoutId: row.id,
        botText: `${em('cancel')} <b>Вывод ${shortUsdt(row.amount_micro)} USDT отклонён</b>\nПричина: ${esc(reason)}\n${em('received')} ${shortUsdt(row.amount_micro + row.fee_micro)} USDT вернулись на баланс.`,
      });
    }
    return this.toAdminDto(row);
  }
}
