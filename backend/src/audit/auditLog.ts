import type { AdminAuditItem, JournalQuery } from '../../../shared/api.js';
import { AUDIT_TYPES, type AuditActor, type AuditType } from '../../../shared/audit.js';
import type { Db } from '../db/database.js';

export interface AuditEntry {
  actor: AuditActor;
  type: AuditType;
  userId?: number | null;
  withdrawalId?: number | null;
  obligationId?: number | null;
  amountMicro?: number | null;
  amountRub?: number | null;
  data?: Record<string, unknown> | null;
}

interface Row {
  id: number;
  at: number;
  actor: AuditActor;
  type: AuditType;
  user_id: number | null;
  withdrawal_id: number | null;
  obligation_id: number | null;
  amount_micro: number | null;
  amount_rub: number | null;
  data: string | null;
  username: string | null;
  first_name: string | null;
}

const PAGE = 100;

/** Append-only journal of everything that matters: deals, money, access, notifications. */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  log(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (at, actor, type, user_id, withdrawal_id, obligation_id, amount_micro, amount_rub, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(), e.actor, e.type, e.userId ?? null, e.withdrawalId ?? null, e.obligationId ?? null,
        e.amountMicro ?? null, e.amountRub ?? null, e.data ? JSON.stringify(e.data) : null,
      );
  }

  forDeal(withdrawalId: number): AdminAuditItem[] {
    return this.select('WHERE a.withdrawal_id = ? ORDER BY a.id', [withdrawalId]);
  }

  /** Newest first, 100 per page; `before` is the last id of the previous page. */
  query(q: JournalQuery): AdminAuditItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const types = (q.types ?? '').split(',').filter((t) => t in AUDIT_TYPES);
    if (types.length) {
      where.push(`a.type IN (${types.map(() => '?').join(',')})`);
      args.push(...types);
    }
    if (q.userId) where.push('a.user_id = ?'), args.push(q.userId);
    if (q.dealId) where.push('a.withdrawal_id = ?'), args.push(q.dealId);
    if (q.from) where.push('a.at >= ?'), args.push(q.from);
    if (q.to) where.push('a.at <= ?'), args.push(q.to);
    if (q.before) where.push('a.id < ?'), args.push(q.before);
    const text = (q.q ?? '').trim().replace(/^@/, '');
    if (text) {
      where.push('(u.username LIKE ? COLLATE NOCASE OR u.first_name LIKE ? COLLATE NOCASE OR a.data LIKE ? OR CAST(a.withdrawal_id AS TEXT) = ?)');
      args.push(`%${text}%`, `%${text}%`, `%${text}%`, text.replace(/^№|^#/, ''));
    }
    return this.select(`${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ${PAGE}`, args);
  }

  private select(tail: string, args: (string | number)[]): AdminAuditItem[] {
    const rows = this.db
      .prepare(`SELECT a.*, u.username, u.first_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${tail}`)
      .all(...args) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actor,
      type: r.type,
      label: AUDIT_TYPES[r.type] ?? r.type,
      userId: r.user_id,
      username: r.username,
      firstName: r.first_name,
      withdrawalId: r.withdrawal_id,
      obligationId: r.obligation_id,
      amountMicro: r.amount_micro,
      amountRub: r.amount_rub,
      data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null,
    }));
  }
}
