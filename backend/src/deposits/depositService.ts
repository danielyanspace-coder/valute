import type {
  AdminDepositAddressDto,
  AdminDepositCounts,
  AdminDepositDto,
  AdminUserRef,
  DepositDto,
  DepositRequestDto,
  DepositStatus,
} from '../../../shared/api.js';
import {
  DEPOSIT_QUARANTINE_MS,
  DEPOSIT_REQUEST_TTL_MS,
  SHARED_SENDER_USERS,
  type DepositRequestStatus,
  type DepositReview,
} from '../../../shared/deposits.js';
import { shortUsdt } from '../../../shared/transfers.js';
import type { AmlService } from '../aml/amlService.js';
import type { AuditLog } from '../audit/auditLog.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { UserRepo } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';
import type { IncomingTransfer, TronChain } from './tronClient.js';
import { isTronAddress } from './tronHd.js';

const CHAIN = 'TRON';
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** How often a pool address is polled. */
export const POLL_SCHEDULE = {
  hot: 20 * SEC, // lent out, in quarantine, or a deposit waits for confirmation
  idle: 10 * MIN, // free: catches people who reuse an old address
};
/** Re-read this much history before the cursor: the index may add late transfers. */
const CURSOR_OVERLAP = HOUR;
/** A transfer the solidified chain still does not know after this long is dropped. */
const UNCONFIRMED_GIVE_UP = 6 * HOUR;
/** Spam dust (address poisoning sends 0.0001 USDT): not recorded at all. */
export const DUST_MICRO = 100_000; // 0.1 USDT
/** How long to retry AML checks that failed to run before holding the deposit. */
const AML_RETRY_WINDOW = 30 * MIN;
/** Block time vs. our clock: a transfer this much "before" the request still counts for it. */
const CLOCK_SKEW = MIN;
/** An ended request is still shown to the user for this long ("time is up", "received"). */
const SHOW_ENDED = 10 * MIN;

export interface DepositRow {
  id: number;
  user_id: number | null;
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
  request_id: number | null;
  issued_to: number | null;
  late: number;
  review: DepositReview | null;
}

interface PoolRow {
  id: number;
  address: string;
  label: string;
  enabled: number;
  own: number;
  created_at: number;
  last_checked_at: number | null;
  cursor_ts: number | null;
}

interface RequestRow {
  id: number;
  user_id: number;
  address: string;
  status: DepositRequestStatus;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
}

/** Who a transfer belongs to, decided from the address, its time and the sender wallet. */
interface Attribution {
  userId: number | null;
  issuedTo: number | null;
  requestId: number | null;
  late: boolean;
  review: DepositReview | null;
}

export interface DepositServiceOptions {
  minDepositMicro: number;
  /** Address checks per tick, to stay inside TronGrid limits. */
  batchSize: number;
  audit?: AuditLog;
  log?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

/**
 * Deposits through a pool of public addresses. A user asks for an address, gets one
 * nobody else holds, and has 15 minutes to send. Whatever arrives while the request is
 * open, or during the 30-minute quarantine after it, is that user's. Anything else
 * (an address nobody held, a sender wallet that belongs to someone else) goes to the operator.
 *
 * Money is credited only after the solidity node confirms the tx (irreversible block),
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

  // ---------- requests (user) ----------

  /** true when at least one address can be lent out. */
  enabled(): boolean {
    return !!this.db.prepare('SELECT 1 FROM deposit_pool WHERE enabled = 1 AND own = 0 LIMIT 1').get();
  }

  /** The open request, or a recently ended one so the screen can say what happened. */
  current(userId: number): DepositRequestDto | null {
    this.expireRequests();
    const r = this.db
      .prepare('SELECT * FROM deposit_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId) as unknown as RequestRow | undefined;
    if (!r) return null;
    if (r.status === 'cancelled') return null;
    if (r.status !== 'active' && (r.ended_at ?? 0) < this.now() - SHOW_ENDED) return null;
    return this.requestDto(r);
  }

  /** Lends an address. One open request per user: the old one must be cancelled first. */
  open(userId: number): DepositRequestDto {
    this.expireRequests();
    const r = transaction(this.db, () => {
      if (this.activeRequest(userId)) throw new AppError(409, 'request_active', 'Сначала отмените текущую заявку');
      const address = this.pickAddress(userId);
      if (!address) {
        const retryAt = this.nextFreeAt();
        throw new AppError(409, 'pool_busy', 'Все адреса сейчас заняты. Попробуйте чуть позже', { retryAt });
      }
      const now = this.now();
      const res = this.db
        .prepare(`INSERT INTO deposit_requests (user_id, address, status, created_at, expires_at) VALUES (?, ?, 'active', ?, ?)`)
        .run(userId, address, now, now + DEPOSIT_REQUEST_TTL_MS);
      return this.request(Number(res.lastInsertRowid))!;
    });
    return this.requestDto(r);
  }

  cancel(userId: number): void {
    const res = this.db
      .prepare(`UPDATE deposit_requests SET status = 'cancelled', ended_at = ? WHERE user_id = ? AND status = 'active'`)
      .run(this.now(), userId);
    if (Number(res.changes) !== 1) throw new AppError(409, 'no_request', 'Активной заявки нет');
  }

  private activeRequest(userId: number): RequestRow | null {
    return (this.db.prepare(`SELECT * FROM deposit_requests WHERE user_id = ? AND status = 'active'`).get(userId) as unknown as RequestRow | undefined) ?? null;
  }

  private request(id: number): RequestRow | null {
    return (this.db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(id) as unknown as RequestRow | undefined) ?? null;
  }

  private requestDto(r: RequestRow): DepositRequestDto {
    const received = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_micro), 0) AS s, COALESCE(SUM(CASE WHEN status = 'credited' THEN amount_micro END), 0) AS c
         FROM deposits WHERE request_id = ? AND status != 'failed'`,
      )
      .get(r.id) as { s: number; c: number };
    return {
      id: r.id,
      address: r.address,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      endedAt: r.ended_at,
      receivedMicro: Number(received.s),
      creditedMicro: Number(received.c),
      serverNow: this.now(),
    };
  }

  private expireRequests(): void {
    this.db.prepare(`UPDATE deposit_requests SET status = 'expired', ended_at = expires_at WHERE status = 'active' AND expires_at <= ?`).run(this.now());
  }

  /** The latest request on the address and when the address is free again. */
  private lastOn(address: string): { r: RequestRow; freeAt: number } | null {
    const r = this.db
      .prepare('SELECT * FROM deposit_requests WHERE address = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(address) as unknown as RequestRow | undefined;
    if (!r) return null;
    const end = r.status === 'active' ? r.expires_at : (r.ended_at ?? r.expires_at);
    return { r, freeAt: end + DEPOSIT_QUARANTINE_MS };
  }

  /**
   * The user's own address still in quarantine comes first (they may have saved it),
   * then the free address that has rested the longest.
   */
  private pickAddress(userId: number): string | null {
    const now = this.now();
    const pool = this.db.prepare('SELECT * FROM deposit_pool WHERE enabled = 1 AND own = 0 ORDER BY id').all() as unknown as PoolRow[];
    let best: { address: string; restedSince: number } | null = null;
    for (const p of pool) {
      const last = this.lastOn(p.address);
      if (last && last.r.user_id === userId && last.r.status !== 'active' && last.freeAt > now) return p.address;
      if (last && last.freeAt > now) continue;
      const restedSince = last ? last.freeAt : 0;
      if (!best || restedSince < best.restedSince) best = { address: p.address, restedSince };
    }
    return best?.address ?? null;
  }

  private nextFreeAt(): number {
    const pool = this.db.prepare('SELECT address FROM deposit_pool WHERE enabled = 1 AND own = 0').all() as unknown as { address: string }[];
    const times = pool.map((p) => this.lastOn(p.address)?.freeAt ?? 0);
    return times.length ? Math.min(...times) : this.now();
  }

  // ---------- attribution ----------

  /** The request whose window (open time plus quarantine) covers the moment of the transfer. */
  private holderAt(address: string, ts: number): { r: RequestRow; late: boolean } | null {
    const r = this.db
      .prepare('SELECT * FROM deposit_requests WHERE address = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(address, ts + CLOCK_SKEW) as unknown as RequestRow | undefined;
    if (!r) return null;
    const end = r.status === 'active' ? Infinity : (r.ended_at ?? r.expires_at);
    if (ts <= end) return { r, late: false };
    if (ts <= end + DEPOSIT_QUARANTINE_MS) return { r, late: true };
    return null;
  }

  /** Users this wallet already topped up (credited deposits only). */
  private usersOfSender(from: string | null, excludeDeposit = 0): number[] {
    if (!from) return [];
    const rows = this.db
      .prepare(`SELECT DISTINCT user_id FROM deposits WHERE from_address = ? AND status = 'credited' AND user_id IS NOT NULL AND id != ?`)
      .all(from, excludeDeposit) as unknown as { user_id: number }[];
    return rows.map((r) => r.user_id);
  }

  private attribute(address: string, ts: number, from: string | null, depositId = 0): Attribution {
    const holder = this.holderAt(address, ts);
    const known = this.usersOfSender(from, depositId);
    // An exchange hot wallet sends for thousands of people: it says nothing about who this is.
    const telling = known.length > 0 && known.length < SHARED_SENDER_USERS;
    if (holder) {
      const uid = holder.r.user_id;
      const conflict = telling && !known.includes(uid);
      return { userId: uid, issuedTo: uid, requestId: holder.r.id, late: holder.late, review: conflict ? 'sender_conflict' : null };
    }
    if (telling) return { userId: null, issuedTo: null, requestId: null, late: false, review: 'linked_sender' };
    return { userId: null, issuedTo: null, requestId: null, late: false, review: 'unidentified' };
  }

  private isOwnWallet(address: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM deposit_pool WHERE address = ?').get(address);
  }

  // ---------- watcher ----------

  /** One watcher pass over the addresses that are due. Never run two at once. */
  async tick(): Promise<void> {
    this.expireRequests();
    for (const a of this.dueAddresses()) {
      try {
        await this.scan(a);
      } catch (err) {
        this.opts.log?.warn({ err, address: a.address }, 'deposit scan failed');
      } finally {
        this.db.prepare('UPDATE deposit_pool SET last_checked_at = ? WHERE id = ?').run(this.now(), a.id);
      }
    }
  }

  dueAddresses(): PoolRow[] {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT p.*, EXISTS (SELECT 1 FROM deposits d WHERE d.chain = ? AND d.address = p.address AND d.status = 'pending') AS has_pending
         FROM deposit_pool p WHERE p.own = 0`,
      )
      .all(CHAIN) as unknown as (PoolRow & { has_pending: number })[];
    const interval = (a: PoolRow & { has_pending: number }) => {
      const last = this.lastOn(a.address);
      return a.has_pending || (last && last.freeAt > now) ? POLL_SCHEDULE.hot : POLL_SCHEDULE.idle;
    };
    return rows
      .map((a) => ({ a, overdue: now - (a.last_checked_at ?? 0) - interval(a) }))
      .filter((x) => x.overdue >= 0)
      .sort((x, y) => y.overdue - x.overdue)
      .slice(0, this.opts.batchSize)
      .map((x) => x.a);
  }

  private async scan(a: PoolRow): Promise<void> {
    // Before the address joined the pool its history is the operator's own business.
    const since = a.cursor_ts === null ? a.created_at : Math.max(a.created_at, a.cursor_ts - CURSOR_OVERLAP);
    const incoming = await this.chain.incomingUsdt(a.address, since);
    this.recordSeen(a, incoming);

    const pending = this.db
      .prepare(`SELECT * FROM deposits WHERE chain = ? AND address = ? AND status = 'pending' ORDER BY id`)
      .all(CHAIN, a.address) as unknown as DepositRow[];
    for (const d of pending) await this.confirm(d);
  }

  private recordSeen(a: PoolRow, incoming: IncomingTransfer[]): void {
    let cursor = a.cursor_ts ?? a.created_at;
    for (const t of incoming) {
      cursor = Math.max(cursor, t.blockTimestamp);
      if (t.valueMicro < DUST_MICRO || this.isOwnWallet(t.from)) continue;
      if (this.db.prepare('SELECT 1 FROM deposits WHERE chain = ? AND tx_id = ? AND address = ?').get(CHAIN, t.txId, a.address)) continue;
      const at = this.attribute(a.address, t.blockTimestamp, t.from);
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO deposits (user_id, chain, address, tx_id, from_address, amount_micro, status, block_time, seen_at, request_id, issued_to, late, review)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          )
          .run(at.issuedTo, CHAIN, a.address, t.txId, t.from, t.valueMicro, t.blockTimestamp, this.now(), at.requestId, at.issuedTo, at.late ? 1 : 0, at.review);
        // Money arrived: the request is done, the quarantine starts now.
        if (at.requestId && !at.late) {
          this.db.prepare(`UPDATE deposit_requests SET status = 'paid', ended_at = ? WHERE id = ? AND status = 'active'`).run(this.now(), at.requestId);
        }
      });
    }
    this.db.prepare('UPDATE deposit_pool SET cursor_ts = ? WHERE id = ?').run(cursor, a.id);
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
    // The chain is the source of truth for amount, sender and time, not the index.
    const sender = verdict.from || d.from_address || '';
    if (sender && this.isOwnWallet(sender)) {
      this.finish(d.id, 'failed', { note: 'transfer between own wallets' });
      return;
    }
    const at = this.attribute(d.address, verdict.blockTimestamp, sender || null, d.id);
    this.db
      .prepare(
        `UPDATE deposits SET amount_micro = ?, from_address = ?, block_number = ?, block_time = ?, confirmed_at = ?,
           user_id = ?, issued_to = ?, request_id = ?, late = ?, review = ? WHERE id = ?`,
      )
      .run(verdict.valueMicro, sender || null, verdict.blockNumber, verdict.blockTimestamp, this.now(), at.issuedTo, at.issuedTo, at.requestId, at.late ? 1 : 0, at.review, d.id);

    const aml = await this.aml.screen('TRON', sender);
    this.db.prepare('UPDATE deposits SET aml_decision = ?, aml_detail = ? WHERE id = ?').run(aml.decision, JSON.stringify(aml.signals), d.id);
    // A check that could not run (network) is retried for a while before bothering an operator.
    if (aml.decision === 'review' && this.now() - d.seen_at < AML_RETRY_WINDOW) return;
    if (aml.decision !== 'clear') {
      this.db.prepare(`UPDATE deposits SET review = 'aml' WHERE id = ?`).run(d.id);
      this.finish(d.id, 'held', {});
      this.opts.log?.warn({ deposit: d.id, decision: aml.decision, sender }, 'deposit held by AML');
      return;
    }
    if (at.review) {
      this.finish(d.id, 'held', {});
      this.opts.log?.info({ deposit: d.id, review: at.review }, 'deposit needs the operator');
      return;
    }
    if (verdict.valueMicro < this.opts.minDepositMicro) {
      this.finish(d.id, 'below_min', {});
      return;
    }
    this.credit(d.id, 'auto', null, null);
  }

  private finish(id: number, status: DepositRow['status'], o: { note?: string }): boolean {
    const res = this.db
      .prepare(`UPDATE deposits SET status = ?, finished_at = ?, admin_note = COALESCE(?, admin_note) WHERE id = ? AND status = 'pending'`)
      .run(status, status === 'held' ? null : this.now(), o.note ?? null, id);
    return Number(res.changes) === 1;
  }

  /** Puts the deposit on a balance exactly once. */
  private credit(id: number, by: 'auto' | 'admin', note: string | null, toUser: number | null): DepositRow {
    const row = transaction(this.db, () => {
      const before = this.get(id);
      if (!before) throw new AppError(404, 'not_found', 'Пополнение не найдено');
      const userId = toUser ?? before.user_id;
      if (!userId) throw new AppError(400, 'user_required', 'Выберите, кому зачислить');
      if (!this.users.get(userId)) throw new AppError(404, 'user_not_found', 'Пользователь не найден');
      const res = this.db
        .prepare(
          `UPDATE deposits SET status = 'credited', user_id = ?, finished_at = ?, credited_by = ?, admin_note = COALESCE(?, admin_note)
           WHERE id = ? AND status IN ('pending', 'held', 'below_min')`,
        )
        .run(userId, this.now(), by, note, id);
      if (Number(res.changes) !== 1) throw new AppError(409, 'deposit_state', 'Пополнение уже обработано');
      const d = this.get(id)!;
      this.opts.audit?.log({
        actor: by === 'auto' ? 'system' : 'admin',
        type: 'deposit_credited',
        userId,
        amountMicro: d.amount_micro,
        data: { depositId: d.id, txId: d.tx_id, late: !!d.late, review: d.review },
      });
      this.ledger.post([{ userId, bucket: 'available', amountMicro: d.amount_micro, kind: 'deposit', refType: 'deposit', refId: d.id }]);
      return d;
    });
    const user = this.users.get(row.user_id!);
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

  // ---------- user history ----------

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

  // ---------- admin: deposits ----------

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

  private userRef(id: number | null): AdminUserRef | null {
    if (!id) return null;
    const u = this.users.get(id);
    return u ? { id: u.id, username: u.username, firstName: u.first_name, telegramId: u.telegram_id } : { id, username: null, firstName: `#${id}`, telegramId: 0 };
  }

  toAdminDto(d: DepositRow): AdminDepositDto {
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
      user: this.userRef(d.user_id),
      review: d.review,
      late: !!d.late,
      requestId: d.request_id,
      issuedTo: this.userRef(d.issued_to),
      senderUsers: this.usersOfSender(d.from_address, d.id).map((id) => this.userRef(id)!),
    };
  }

  /** Operator credits a held or below-minimum deposit, to the chosen user if it is not identified. */
  creditByAdmin(id: number, note: string | null, userId?: number | null): AdminDepositDto {
    return this.toAdminDto(this.credit(id, 'admin', note?.trim() || null, userId || null));
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

  // ---------- admin: address pool ----------

  poolList(): AdminDepositAddressDto[] {
    this.expireRequests();
    const now = this.now();
    const rows = this.db.prepare('SELECT * FROM deposit_pool ORDER BY own, id').all() as unknown as PoolRow[];
    return rows.map((p) => {
      const last = this.lastOn(p.address);
      const stats = this.db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro), 0) AS s FROM deposits WHERE address = ? AND status = 'credited'`)
        .get(p.address) as { n: number; s: number };
      const lent = last && last.freeAt > now ? last : null;
      const state: AdminDepositAddressDto['state'] = p.own
        ? 'own'
        : lent?.r.status === 'active'
          ? 'busy'
          : lent
            ? 'quarantine'
            : p.enabled
              ? 'free'
              : 'off';
      return {
        id: p.id,
        address: p.address,
        label: p.label,
        enabled: !!p.enabled,
        own: !!p.own,
        state,
        holder: lent ? this.userRef(lent.r.user_id) : null,
        until: lent ? (lent.r.status === 'active' ? lent.r.expires_at : lent.freeAt) : null,
        createdAt: p.created_at,
        lastCheckedAt: p.last_checked_at,
        depositsCount: Number(stats.n),
        receivedMicro: Number(stats.s),
      };
    });
  }

  poolAdd(address: string, label: string, own: boolean): AdminDepositAddressDto[] {
    const a = address.trim();
    if (!isTronAddress(a)) throw new AppError(400, 'bad_address', 'Это не адрес TRON. Он начинается на T и состоит из 34 символов');
    if (this.isOwnWallet(a)) throw new AppError(409, 'exists', 'Этот адрес уже добавлен');
    this.db.prepare('INSERT INTO deposit_pool (address, label, own, created_at) VALUES (?, ?, ?, ?)').run(a, label.trim().slice(0, 40), own ? 1 : 0, this.now());
    this.opts.audit?.log({ actor: 'admin', type: 'manual_adjustment', data: { action: own ? 'own_wallet_added' : 'deposit_address_added', address: a } });
    return this.poolList();
  }

  poolUpdate(id: number, patch: { enabled?: boolean; label?: string }): AdminDepositAddressDto[] {
    const p = this.db.prepare('SELECT * FROM deposit_pool WHERE id = ?').get(id) as unknown as PoolRow | undefined;
    if (!p) throw new AppError(404, 'not_found', 'Адрес не найден');
    if (patch.enabled !== undefined) this.db.prepare('UPDATE deposit_pool SET enabled = ? WHERE id = ?').run(patch.enabled ? 1 : 0, id);
    if (patch.label !== undefined) this.db.prepare('UPDATE deposit_pool SET label = ? WHERE id = ?').run(patch.label.trim().slice(0, 40), id);
    return this.poolList();
  }

  /** Only an address that was never lent out can be removed; a used one is switched off instead. */
  poolRemove(id: number): AdminDepositAddressDto[] {
    const p = this.db.prepare('SELECT * FROM deposit_pool WHERE id = ?').get(id) as unknown as PoolRow | undefined;
    if (!p) throw new AppError(404, 'not_found', 'Адрес не найден');
    const used = this.db.prepare('SELECT 1 FROM deposit_requests WHERE address = ? UNION SELECT 1 FROM deposits WHERE address = ?').get(p.address, p.address);
    if (used) throw new AppError(409, 'address_used', 'Адрес уже выдавался. Его можно только выключить');
    this.db.prepare('DELETE FROM deposit_pool WHERE id = ?').run(id);
    return this.poolList();
  }
}
