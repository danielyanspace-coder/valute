import type { AdminObligationDto, CreateObligationRequest, DeductionDto, ObligationStatus } from '../../../shared/api.js';
import { USDT_MICRO } from '../../../shared/payout.js';
import { shortUsdt } from '../../../shared/transfers.js';
import type { AuditLog } from '../audit/auditLog.js';
import { transaction, type Db } from '../db/database.js';
import { OBLIGATION_REPAY, type Ledger } from '../ledger/ledger.js';
import type { InlineButton } from '../notifications/messenger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { UserRepo } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';

export const DEFAULT_PUBLIC_REASON = 'в предыдущей сделке вам было перечислено больше необходимой суммы';

interface Row {
  id: number;
  user_id: number;
  amount_micro: number;
  repaid_micro: number;
  status: ObligationStatus;
  public_reason: string;
  comment: string | null;
  withdrawal_id: number | null;
  created_at: number;
  repaid_at: number | null;
  written_off_at: number | null;
  write_off_comment: string | null;
}

/**
 * Shadow obligations: USDT a user owes (e.g. was overpaid). Invisible to the user until
 * money is actually held back. Every time the available balance grows, active
 * obligations take what they can in the same DB transaction, oldest first.
 */
export class ObligationService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly users: UserRepo,
    private readonly notifications: NotificationService,
    private readonly audit: AuditLog,
    private readonly supportUsername: string,
    private readonly now: () => number = Date.now,
  ) {
    ledger.onAvailableCredit = (userId) => this.settle(userId);
  }

  /** Admin creates an obligation; it is held right away from whatever the user has available. */
  create(req: CreateObligationRequest): AdminObligationDto {
    return transaction(this.db, () => this.createInTx(req));
  }

  /** Same as create, for callers that already hold a transaction (deal corrections). */
  createInTx(req: CreateObligationRequest): AdminObligationDto {
    const amountMicro = Math.round(Number(req.amountUsdt) * USDT_MICRO);
    if (!Number.isFinite(amountMicro) || amountMicro <= 0) throw new AppError(400, 'amount', 'Укажите сумму в USDT');
    const user = this.users.get(Number(req.userId));
    if (!user) throw new AppError(404, 'not_found', 'Пользователь не найден');
    const publicReason = (req.publicReason ?? '').trim().slice(0, 300) || DEFAULT_PUBLIC_REASON;
    const comment = (req.comment ?? '').trim().slice(0, 1000) || null;
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO obligations (user_id, amount_micro, status, public_reason, comment, withdrawal_id, created_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(user.id, amountMicro, publicReason, comment, req.withdrawalId ?? null, this.now());
    const id = Number(lastInsertRowid);
    this.audit.log({
      actor: 'admin', type: 'obligation_created', userId: user.id, obligationId: id, withdrawalId: req.withdrawalId ?? null,
      amountMicro, data: { publicReason, comment },
    });
    this.settle(user.id);
    return this.get(id);
  }

  /** Must run inside a transaction (the ledger hook and create() guarantee it). */
  settle(userId: number): void {
    const active = this.db
      .prepare(`SELECT * FROM obligations WHERE user_id = ? AND status = 'active' ORDER BY id`)
      .all(userId) as unknown as Row[];
    if (!active.length) return;
    let available = this.ledger.balances(userId).availableMicro;
    let held = 0;
    const reasons: string[] = [];
    let firstId = 0;
    for (const o of active) {
      if (available <= 0) break;
      const take = Math.min(o.amount_micro - o.repaid_micro, available);
      if (take <= 0) continue;
      this.ledger.post([{ userId, bucket: 'available', amountMicro: -take, kind: OBLIGATION_REPAY, refType: 'obligation', refId: o.id }]);
      const repaid = o.repaid_micro + take;
      const done = repaid >= o.amount_micro;
      this.db
        .prepare(`UPDATE obligations SET repaid_micro = ?, status = ?, repaid_at = ? WHERE id = ?`)
        .run(repaid, done ? 'repaid' : 'active', done ? this.now() : null, o.id);
      this.audit.log({
        actor: 'system', type: 'obligation_repaid', userId, obligationId: o.id, withdrawalId: o.withdrawal_id,
        amountMicro: take, data: { repaidMicro: repaid, leftMicro: o.amount_micro - repaid, fully: done },
      });
      available -= take;
      held += take;
      firstId ||= o.id;
      if (!reasons.includes(o.public_reason)) reasons.push(o.public_reason);
    }
    if (!held) return;
    const user = this.users.get(userId);
    if (!user) return;
    const buttons: InlineButton[][] | undefined = this.supportUsername ? [[{ text: 'Поддержка', url: `https://t.me/${this.supportUsername}` }]] : undefined;
    this.notifications.notify(user, 'obligation_repaid', {
      obligationId: firstId,
      amountMicro: held,
      botText: holdText(held, reasons),
      buttons,
    });
  }

  writeOff(id: number, comment: string): AdminObligationDto {
    const text = comment.trim().slice(0, 500);
    if (!text) throw new AppError(400, 'comment', 'Укажите причину списания');
    return transaction(this.db, () => {
      const o = this.row(id);
      const res = this.db
        .prepare(`UPDATE obligations SET status = 'written_off', written_off_at = ?, write_off_comment = ? WHERE id = ? AND status = 'active'`)
        .run(this.now(), text, id);
      if (Number(res.changes) !== 1) throw new AppError(409, 'obligation_state', 'Обязательство уже закрыто');
      this.audit.log({
        actor: 'admin', type: 'obligation_written_off', userId: o.user_id, obligationId: id, withdrawalId: o.withdrawal_id,
        amountMicro: o.amount_micro - o.repaid_micro, data: { comment: text },
      });
      return this.get(id);
    });
  }

  list(filter: { status?: string; userId?: number }): AdminObligationDto[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status && ['active', 'repaid', 'written_off'].includes(filter.status)) where.push('status = ?'), args.push(filter.status);
    if (filter.userId) where.push('user_id = ?'), args.push(filter.userId);
    const rows = this.db
      .prepare(`SELECT * FROM obligations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY status = 'active' DESC, id DESC LIMIT 300`)
      .all(...args) as unknown as Row[];
    return rows.map((r) => this.dto(r));
  }

  leftForUser(userId: number): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(SUM(amount_micro - repaid_micro), 0) AS t FROM obligations WHERE user_id = ? AND status = 'active'`)
        .get(userId) as { t: number }
    ).t;
  }

  /** Holds that already happened: the only part the user ever sees (history). */
  deductionsForUser(userId: number): DeductionDto[] {
    return (
      this.db
        .prepare(
          `SELECT e.id, -e.amount_micro AS amountMicro, o.public_reason AS reason, e.created_at AS createdAt
           FROM ledger_entries e JOIN obligations o ON o.id = e.ref_id
           WHERE e.user_id = ? AND e.kind = ? ORDER BY e.id DESC LIMIT 100`,
        )
        .all(userId, OBLIGATION_REPAY) as unknown as DeductionDto[]
    ).map((d) => ({ ...d, reason: capitalize(d.reason) }));
  }

  get(id: number): AdminObligationDto {
    return this.dto(this.row(id));
  }

  private row(id: number): Row {
    const r = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) throw new AppError(404, 'not_found', 'Обязательство не найдено');
    return r;
  }

  private dto(r: Row): AdminObligationDto {
    const u = this.users.get(r.user_id);
    const repayments = this.db
      .prepare(`SELECT created_at AS at, -amount_micro AS amountMicro FROM ledger_entries WHERE kind = ? AND ref_type = 'obligation' AND ref_id = ? ORDER BY id`)
      .all(OBLIGATION_REPAY, r.id) as unknown as { at: number; amountMicro: number }[];
    return {
      id: r.id,
      status: r.status,
      amountMicro: r.amount_micro,
      repaidMicro: r.repaid_micro,
      publicReason: r.public_reason,
      comment: r.comment,
      withdrawalId: r.withdrawal_id,
      createdAt: r.created_at,
      repaidAt: r.repaid_at,
      writtenOffAt: r.written_off_at,
      writeOffComment: r.write_off_comment,
      user: { id: r.user_id, username: u?.username ?? null, firstName: u?.first_name ?? '', telegramId: u?.telegram_id ?? 0 },
      repayments,
    };
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function holdText(heldMicro: number, reasons: string[]): string {
  return (
    `С вашего баланса удержано ${shortUsdt(heldMicro)} USDT.\n\n` +
    `Причина: ${reasons.join('; ')}.\n\n` +
    'Если вы не согласны с удержанием, свяжитесь с поддержкой.'
  );
}
