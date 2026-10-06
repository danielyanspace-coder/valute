import type { Db } from '../db/database.js';

export type Bucket = 'available' | 'frozen';

/** Ledger kind of a shadow-obligation hold; never triggers another hold. */
export const OBLIGATION_REPAY = 'obligation_repay';

export interface Balances {
  availableMicro: number;
  frozenMicro: number;
}

interface Entry {
  userId: number;
  bucket: Bucket;
  amountMicro: number;
  kind: string;
  refType?: string;
  refId?: number;
  comment?: string;
}

/**
 * Append-only balance journal. Moving money between buckets is two rows,
 * so the sum over both buckets only changes on real inflows and outflows.
 */
export class Ledger {
  /**
   * Called inside the same DB transaction whenever a user's available balance grows.
   * Shadow obligations use it to hold money back before the user can spend it.
   */
  onAvailableCredit: ((userId: number) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  balances(userId: number): Balances {
    const rows = this.db
      .prepare('SELECT bucket, COALESCE(SUM(amount_micro), 0) AS total FROM ledger_entries WHERE user_id = ? GROUP BY bucket')
      .all(userId) as unknown as { bucket: Bucket; total: number }[];
    const get = (b: Bucket) => rows.find((r) => r.bucket === b)?.total ?? 0;
    return { availableMicro: get('available'), frozenMicro: get('frozen') };
  }

  post(entries: Entry[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO ledger_entries (user_id, bucket, amount_micro, kind, ref_type, ref_id, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = this.now();
    const credited = new Set<number>();
    for (const e of entries) {
      stmt.run(e.userId, e.bucket, e.amountMicro, e.kind, e.refType ?? null, e.refId ?? null, e.comment ?? null, now);
      if (e.bucket === 'available' && e.amountMicro > 0 && e.kind !== OBLIGATION_REPAY) credited.add(e.userId);
    }
    if (this.onAvailableCredit) for (const userId of credited) this.onAvailableCredit(userId);
  }

  /** Sum of entries of one kind for a user (e.g. all deposits). */
  totalByKind(userId: number, kind: string, bucket: Bucket = 'available'): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(amount_micro), 0) AS t FROM ledger_entries WHERE user_id = ? AND kind = ? AND bucket = ?')
      .get(userId, kind, bucket) as { t: number };
    return row.t;
  }
}
