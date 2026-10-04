import type { AdminDepositCounts, AdminDepositDto, DepositDto, DepositStatus } from '../../../shared/api.js';
import { shortUsdt } from '../../../shared/transfers.js';
import type { AmlService } from '../aml/amlService.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { UserRepo } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';
import type { IncomingTransfer, TronChain } from './tronClient.js';

const CHAIN = 'TRON';
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** How often an address is polled, by how recently its owner opened the deposit screen. */
export const POLL_SCHEDULE = {
  hot: 20 * SEC, // screen opened in the last hour, or a deposit is waiting for confirmation
  warm: 3 * MIN, // opened in the last 3 days
  cold: 30 * MIN, // everyone else: people reuse a saved address
};
/** Re-read this much history before the cursor: the index may add late transfers. */
const CURSOR_OVERLAP = HOUR;
/** A transfer the solidified chain still does not know after this long is dropped. */
const UNCONFIRMED_GIVE_UP = 6 * HOUR;
/** Spam dust (address poisoning sends 0.0001 USDT): not recorded at all. */
export const DUST_MICRO = 100_000; // 0.1 USDT
/** How long to retry AML checks that failed to run before holding the deposit. */
const AML_RETRY_WINDOW = 30 * MIN;

export interface DepositRow {
  id: number;
  user_id: number;
  chain: string;
  address: string;
  tx_id: string;
  from_address: string | null;
  amount_micro: number;
  status: DepositStatus | 'failed';
  aml_decision: string | null;
  aml_detail: string | null;
  block_number: number | null;
  block_time: number | null;
  seen_at: number;
  confirmed_at: number | null;
  finished_at: number | null;
  credited_by: 'auto' | 'admin' | null;
  admin_note: string | null;
}

interface AddressRow {
  user_id: number;
  address: string;
  created_at: number;
  last_checked_at: number | null;
  last_viewed_at: number | null;
  cursor_ts: number | null;
}

export interface DepositServiceOptions {
  minDepositMicro: number;
  /** Address checks per tick, to stay inside TronGrid limits. */
  batchSize: number;
  log?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

/**
 * Deposit watcher. The indexed API only says "there might be a transfer"; money is
 * credited after the solidity node confirms the tx (irreversible block, ~1 minute),
 * the USDT contract emitted Transfer to our address, and the sender passed AML.
 */
export class DepositService {
  constructor(
    private readonly db: Db,
    private readonly chain: TronChain,
    private readonly aml: AmlService,
    private readonly ledger: Ledger,
    private readonly users: UserRepo,
    private readonly notifications: NotificationService,
    private readonly opts: DepositServiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** The owner opened the deposit screen: poll the address often for a while. */
  markViewed(userId: number): void {
    this.db.prepare('UPDATE deposit_addresses SET last_viewed_at = ? WHERE user_id = ? AND chain = ?').run(this.now(), userId, CHAIN);
  }

  /** One watcher pass over the addresses that are due. Safe to call concurrently-free on an interval. */
  async tick(): Promise<void> {
    for (const a of this.dueAddresses()) {
      try {
        await this.scan(a);
      } catch (err) {
        this.opts.log?.warn({ err, address: a.address }, 'deposit scan failed');
      } finally {
        this.db.prepare('UPDATE deposit_addresses SET last_checked_at = ? WHERE chain = ? AND address = ?').run(this.now(), CHAIN, a.address);
      }
    }
  }

  dueAddresses(): AddressRow[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT a.user_id, a.address, a.created_at, a.last_checked_at, a.last_viewed_at, a.cursor_ts,
                EXISTS (SELECT 1 FROM deposits d WHERE d.chain = a.chain AND d.address = a.address AND d.status = 'pending') AS has_pending
         FROM deposit_addresses a WHERE a.chain = ?`,
      )
      .all(CHAIN) as unknown as (AddressRow & { has_pending: number })[];
    const interval = (a: AddressRow & { has_pending: number }) => {
      const viewed = a.last_viewed_at ?? a.created_at;
      if (a.has_pending || now - viewed < HOUR) return POLL_SCHEDULE.hot;
      if (now - viewed < 3 * 24 * HOUR) return POLL_SCHEDULE.warm;
      return POLL_SCHEDULE.cold;
    };
    return rows
      .map((a) => ({ a, overdue: now - (a.last_checked_at ?? 0) - interval(a) }))
      .filter((x) => x.overdue >= 0)
      .sort((x, y) => y.overdue - x.overdue)
      .slice(0, this.opts.batchSize)
      .map((x) => x.a);
  }

  private async scan(a: AddressRow): Promise<void> {
    const since = (a.cursor_ts ?? a.created_at) - CURSOR_OVERLAP;
    const incoming = await this.chain.incomingUsdt(a.address, since);
    this.recordSeen(a, incoming);

    const pending = this.db
      .prepare(`SELECT * FROM deposits WHERE chain = ? AND address = ? AND status = 'pending' ORDER BY id`)
      .all(CHAIN, a.address) as unknown as DepositRow[];
    for (const d of pending) await this.confirm(d);
  }

  private recordSeen(a: AddressRow, incoming: IncomingTransfer[]): void {
    if (!incoming.length) return;
    const insert = this.db.prepare(
      `INSERT INTO deposits (user_id, chain, address, tx_id, from_address, amount_micro, status, block_time, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (chain, tx_id, address) DO NOTHING`,
    );
    let cursor = a.cursor_ts ?? 0;
    for (const t of incoming) {
      cursor = Math.max(cursor, t.blockTimestamp);
      if (t.valueMicro < DUST_MICRO) continue;
      insert.run(a.user_id, CHAIN, a.address, t.txId, t.from, t.valueMicro, t.blockTimestamp, this.now());
    }
    this.db.prepare('UPDATE deposit_addresses SET cursor_ts = ? WHERE chain = ? AND address = ?').run(cursor, CHAIN, a.address);
  }

  private async confirm(d: DepositRow): Promise<void> {
    const verdict = await this.chain.verifyUsdtTo(d.tx_id, d.address);
    if (verdict.state === 'unconfirmed') {
      if (this.now() - d.seen_at > UNCONFIRMED_GIVE_UP) this.finish(d.id, 'failed', { note: 'not confirmed in time' });
      return;
    }
    if (verdict.state === 'failed') {
      this.finish(d.id, 'failed', { note: 'tx failed or moved no USDT to this address' });
      return;
    }
    // The chain is the source of truth for amount and sender, not the index.
    this.db
      .prepare('UPDATE deposits SET amount_micro = ?, from_address = ?, block_number = ?, block_time = ?, confirmed_at = ? WHERE id = ?')
      .run(verdict.valueMicro, verdict.from || d.from_address, verdict.blockNumber, verdict.blockTimestamp, this.now(), d.id);
    const sender = verdict.from || d.from_address || '';
    const aml = await this.aml.screen('TRON', sender);
    this.db.prepare('UPDATE deposits SET aml_decision = ?, aml_detail = ? WHERE id = ?').run(aml.decision, JSON.stringify(aml.signals), d.id);
    // A check that could not run (network) is retried for a while before bothering an operator.
    if (aml.decision === 'review' && this.now() - d.seen_at < AML_RETRY_WINDOW) return;
    if (aml.decision !== 'clear') {
      this.finish(d.id, 'held', {});
      this.opts.log?.warn({ deposit: d.id, decision: aml.decision, sender }, 'deposit held by AML');
      return;
    }
    if (verdict.valueMicro < this.opts.minDepositMicro) {
      this.finish(d.id, 'below_min', {});
      return;
    }
    this.credit(d.id, 'auto', null);
  }

  private finish(id: number, status: DepositRow['status'], o: { note?: string }): boolean {
    const res = this.db
      .prepare(`UPDATE deposits SET status = ?, finished_at = ?, admin_note = COALESCE(?, admin_note) WHERE id = ? AND status = 'pending'`)
      .run(status, status === 'held' ? null : this.now(), o.note ?? null, id);
    return Number(res.changes) === 1;
  }

  /** Puts the deposit on the balance exactly once. */
  private credit(id: number, by: 'auto' | 'admin', note: string | null): DepositRow {
    const row = transaction(this.db, () => {
      const res = this.db
        .prepare(
          `UPDATE deposits SET status = 'credited', finished_at = ?, credited_by = ?, admin_note = COALESCE(?, admin_note)
           WHERE id = ? AND status IN ('pending', 'held', 'below_min')`,
        )
        .run(this.now(), by, note, id);
      if (Number(res.changes) !== 1) throw new AppError(409, 'deposit_state', 'Пополнение уже обработано');
      const d = this.get(id)!;
      this.ledger.post([{ userId: d.user_id, bucket: 'available', amountMicro: d.amount_micro, kind: 'deposit', refType: 'deposit', refId: d.id }]);
      return d;
    });
    const user = this.users.get(row.user_id);
    if (user) {
      this.notifications.notify(user, 'deposit_credited', {
        depositId: row.id,
        botText: `Пополнение +${shortUsdt(row.amount_micro)} USDT зачислено на баланс.`,
      });
    }
    return row;
  }

  get(id: number): DepositRow | null {
    return (this.db.prepare('SELECT * FROM deposits WHERE id = ?').get(id) as unknown as DepositRow | undefined) ?? null;
  }

  // ---------- user ----------

  listForUser(userId: number): DepositRow[] {
    return this.db
      .prepare(`SELECT * FROM deposits WHERE user_id = ? AND status != 'failed' ORDER BY id DESC LIMIT 100`)
      .all(userId) as unknown as DepositRow[];
  }

  toUserDto(d: DepositRow): DepositDto {
    return {
      id: d.id,
      status: d.status === 'failed' ? 'rejected' : d.status,
      amountMicro: d.amount_micro,
      network: 'TRC20',
      txId: d.tx_id,
      fromAddress: d.from_address,
      createdAt: d.block_time ?? d.seen_at,
      creditedAt: d.status === 'credited' ? d.finished_at : null,
    };
  }

  // ---------- admin ----------

  adminCounts(): AdminDepositCounts {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM deposits GROUP BY status').all() as unknown as { status: string; n: number }[];
    const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return { held: get('held'), below_min: get('below_min'), pending: get('pending'), credited: get('credited'), rejected: get('rejected') };
  }

  adminList(status: string): AdminDepositDto[] {
    const rows = this.db
      .prepare(
        status === 'all'
          ? 'SELECT * FROM deposits ORDER BY id DESC LIMIT 200'
          : 'SELECT * FROM deposits WHERE status = ? ORDER BY id DESC LIMIT 200',
      )
      .all(...(status === 'all' ? [] : [status])) as unknown as DepositRow[];
    return rows.map((d) => this.toAdminDto(d));
  }

  toAdminDto(d: DepositRow): AdminDepositDto {
    const u = this.users.get(d.user_id);
    let signals: AdminDepositDto['amlSignals'] = [];
    try {
      signals = d.aml_detail ? JSON.parse(d.aml_detail) : [];
    } catch {
      /* keep empty */
    }
    return {
      id: d.id,
      status: d.status,
      amountMicro: d.amount_micro,
      address: d.address,
      txId: d.tx_id,
      fromAddress: d.from_address,
      amlDecision: (d.aml_decision as AdminDepositDto['amlDecision']) ?? null,
      amlSignals: signals,
      blockNumber: d.block_number,
      createdAt: d.block_time ?? d.seen_at,
      confirmedAt: d.confirmed_at,
      finishedAt: d.finished_at,
      creditedBy: d.credited_by,
      adminNote: d.admin_note,
      user: { id: d.user_id, username: u?.username ?? null, firstName: u?.first_name ?? '', telegramId: u?.telegram_id ?? 0 },
    };
  }

  /** Operator credits a held or below-minimum deposit. */
  creditByAdmin(id: number, note: string | null): AdminDepositDto {
    return this.toAdminDto(this.credit(id, 'admin', note?.trim() || null));
  }

  /** Operator refuses a held or below-minimum deposit; the USDT stays on the address. */
  rejectByAdmin(id: number, reason: string): AdminDepositDto {
    const r = reason.trim();
    if (!r) throw new AppError(400, 'reason_required', 'Укажите причину');
    const res = this.db
      .prepare(`UPDATE deposits SET status = 'rejected', finished_at = ?, admin_note = ? WHERE id = ? AND status IN ('held', 'below_min')`)
      .run(this.now(), r, id);
    if (Number(res.changes) !== 1) throw new AppError(409, 'deposit_state', 'Пополнение уже обработано');
    return this.toAdminDto(this.get(id)!);
  }
}
