import { randomBytes } from 'node:crypto';
import type { CheckDto, HistoryItem, PersonDto, TransferDto } from '../../../shared/api.js';
import { checkLink, cleanComment, isValidUsername, normalizeUsername, parseUsdt, shortUsdt } from '../../../shared/transfers.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import { em, esc } from '../notifications/emoji.js';
import type { UserRepo, UserRow } from '../users/userRepo.js';
import { AppError, type WithdrawalService } from '../withdrawals/withdrawalService.js';

export interface CheckRow {
  id: number;
  code: string;
  creator_id: number;
  amount_micro: number;
  comment: string | null;
  status: 'active' | 'claimed' | 'cancelled';
  source: 'app' | 'inline';
  request_id: string | null;
  inline_message_id: string | null;
  created_at: number;
  claimed_by: number | null;
  claimed_at: number | null;
  cancelled_at: number | null;
}

export interface TransferRow {
  id: number;
  from_user_id: number;
  to_user_id: number;
  amount_micro: number;
  kind: 'direct' | 'check';
  check_id: number | null;
  comment: string | null;
  request_id: string | null;
  created_at: number;
}

const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function newCheckCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

const mention = (u: { username: string | null; first_name: string }) => (u.username ? `@${u.username}` : u.first_name);

/** Free internal transfers: by username and via checks (like @send in CryptoBot). */
export class TransferService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly ledger: Ledger,
    private readonly notifications: NotificationService,
    private readonly withdrawals: WithdrawalService,
    private readonly botUsername: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------- Direct transfers ----------

  findRecipient(sender: UserRow, usernameInput: string): UserRow {
    const username = normalizeUsername(usernameInput);
    if (!isValidUsername(username)) throw new AppError(400, 'username', 'Введите username, например @durov');
    const u = this.users.findByUsername(username);
    if (!u) {
      throw new AppError(404, 'not_found', 'Пользователь не найден. Он должен хотя бы раз открыть кошелёк, или отправьте ему чек');
    }
    if (u.id === sender.id) throw new AppError(400, 'self', 'Нельзя перевести самому себе');
    return u;
  }

  sendDirect(sender: UserRow, req: { username: string; amount: string | number; comment?: string; requestId: string }): TransferRow {
    this.assertCanSpend(sender);
    const existing = this.db
      .prepare('SELECT * FROM transfers WHERE from_user_id = ? AND request_id = ?')
      .get(sender.id, req.requestId) as unknown as TransferRow | undefined;
    if (existing) return existing;
    const to = this.findRecipient(sender, req.username);
    const amountMicro = this.amount(req.amount);
    const comment = cleanComment(req.comment);

    const t = transaction(this.db, () => {
      this.assertBalance(sender.id, amountMicro);
      const id = this.insertTransfer(sender.id, to.id, amountMicro, 'direct', null, comment, req.requestId);
      this.ledger.post([
        { userId: sender.id, bucket: 'available', amountMicro: -amountMicro, kind: 'transfer_out', refType: 'transfer', refId: id },
        { userId: to.id, bucket: 'available', amountMicro, kind: 'transfer_in', refType: 'transfer', refId: id },
      ]);
      return this.transfer(id)!;
    });
    this.notifications.notify(to, 'transfer_received', {
      transferId: t.id,
      botText: `${em('received')} <b>+${shortUsdt(amountMicro)} USDT</b> от ${esc(mention(sender))}${comment ? `\n${em('support')} «${esc(comment)}»` : ''}`,
    });
    return t;
  }

  // ---------- Checks ----------

  createCheck(creator: UserRow, req: { amount: string | number; comment?: string; requestId?: string }, opts: { code?: string; source?: 'app' | 'inline' } = {}): CheckRow {
    this.assertCanSpend(creator);
    if (req.requestId) {
      const existing = this.db
        .prepare('SELECT * FROM checks WHERE creator_id = ? AND request_id = ?')
        .get(creator.id, req.requestId) as unknown as CheckRow | undefined;
      if (existing) return existing;
    }
    const amountMicro = this.amount(req.amount);
    return transaction(this.db, () => {
      this.assertBalance(creator.id, amountMicro);
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO checks (code, creator_id, amount_micro, comment, status, source, request_id, created_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(opts.code ?? newCheckCode(), creator.id, amountMicro, cleanComment(req.comment), opts.source ?? 'app', req.requestId ?? null, this.now());
      const id = Number(lastInsertRowid);
      this.ledger.post([
        { userId: creator.id, bucket: 'available', amountMicro: -amountMicro, kind: 'check_freeze', refType: 'check', refId: id },
        { userId: creator.id, bucket: 'frozen', amountMicro, kind: 'check_freeze', refType: 'check', refId: id },
      ]);
      return this.check(id)!;
    });
  }

  /**
   * Inline mode: remember what the user is about to send. Nothing is reserved yet;
   * the check is created when Telegram reports the message as sent (or on first claim).
   */
  createOffer(creator: UserRow, amountMicro: number, comment: string | null): string {
    const code = newCheckCode();
    this.db.prepare('DELETE FROM check_offers WHERE created_at < ?').run(this.now() - OFFER_TTL_MS);
    this.db
      .prepare('INSERT INTO check_offers (code, creator_id, amount_micro, comment, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(code, creator.id, amountMicro, comment, this.now());
    return code;
  }

  /** Turns a sent inline offer into a real check; returns the existing check if already done. */
  materializeOffer(code: string, inlineMessageId?: string): CheckRow {
    let c = this.checkByCode(code);
    if (!c) {
      const offer = this.db.prepare('SELECT * FROM check_offers WHERE code = ?').get(code) as
        | { creator_id: number; amount_micro: number; comment: string | null }
        | undefined;
      if (!offer) throw new AppError(404, 'not_found', 'Чек не найден');
      const creator = this.users.get(offer.creator_id)!;
      c = this.createCheck(creator, { amount: offer.amount_micro / 1_000_000, comment: offer.comment ?? undefined }, { code, source: 'inline' });
      this.db.prepare('DELETE FROM check_offers WHERE code = ?').run(code);
    }
    if (inlineMessageId && !c.inline_message_id) {
      this.db.prepare('UPDATE checks SET inline_message_id = ? WHERE id = ?').run(inlineMessageId, c.id);
      c = this.check(c.id)!;
    }
    return c;
  }

  claim(code: string, claimer: UserRow): { check: CheckRow; transfer: TransferRow; creator: UserRow } {
    const existing = this.checkByCode(code);
    const c0 = existing ?? this.materializeOffer(code); // inline feedback may have been lost
    if (c0.creator_id === claimer.id) throw new AppError(400, 'own_check', 'Это ваш чек. Отправьте его другу, и он сможет его получить');
    if (c0.status === 'claimed') throw new AppError(409, 'claimed', 'Этот чек уже активирован');
    if (c0.status === 'cancelled') throw new AppError(409, 'cancelled', 'Этот чек отменён отправителем');

    const result = transaction(this.db, () => {
      const res = this.db
        .prepare(`UPDATE checks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'active'`)
        .run(claimer.id, this.now(), c0.id);
      if (res.changes !== 1) throw new AppError(409, 'claimed', 'Этот чек уже активирован');
      const tid = this.insertTransfer(c0.creator_id, claimer.id, c0.amount_micro, 'check', c0.id, c0.comment, null);
      this.ledger.post([
        { userId: c0.creator_id, bucket: 'frozen', amountMicro: -c0.amount_micro, kind: 'check_payout', refType: 'check', refId: c0.id },
        { userId: claimer.id, bucket: 'available', amountMicro: c0.amount_micro, kind: 'check_claim', refType: 'check', refId: c0.id },
      ]);
      return { check: this.check(c0.id)!, transfer: this.transfer(tid)!, creator: this.users.get(c0.creator_id)! };
    });
    this.notifications.notify(result.creator, 'check_claimed', {
      checkId: c0.id,
      botText: `${em('check')} Ваш чек на <b>${shortUsdt(c0.amount_micro)} USDT</b> активировал ${esc(mention(claimer))}.`,
    });
    // The bot replies to the claimer directly in the chat, so the in-app notice carries no bot message.
    this.notifications.notify(claimer, 'transfer_received', { transferId: result.transfer.id, botText: null });
    return result;
  }

  cancelCheck(creatorId: number, checkId: number): CheckRow {
    return transaction(this.db, () => {
      const c = this.check(checkId);
      if (!c || c.creator_id !== creatorId) throw new AppError(404, 'not_found', 'Чек не найден');
      const res = this.db
        .prepare(`UPDATE checks SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'`)
        .run(this.now(), checkId);
      if (res.changes !== 1) throw new AppError(409, 'not_active', 'Чек уже активирован или отменён');
      this.ledger.post([
        { userId: creatorId, bucket: 'frozen', amountMicro: -c.amount_micro, kind: 'check_refund', refType: 'check', refId: checkId },
        { userId: creatorId, bucket: 'available', amountMicro: c.amount_micro, kind: 'check_refund', refType: 'check', refId: checkId },
      ]);
      return this.check(checkId)!;
    });
  }

  checksOf(userId: number, limit = 50): CheckRow[] {
    return this.db
      .prepare('SELECT * FROM checks WHERE creator_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit) as unknown as CheckRow[];
  }

  checkByCode(code: string): CheckRow | undefined {
    return this.db.prepare('SELECT * FROM checks WHERE code = ?').get(code) as unknown as CheckRow | undefined;
  }

  check(id: number): CheckRow | undefined {
    return this.db.prepare('SELECT * FROM checks WHERE id = ?').get(id) as unknown as CheckRow | undefined;
  }

  transfer(id: number): TransferRow | undefined {
    return this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as unknown as TransferRow | undefined;
  }

  // ---------- History & DTOs ----------

  history(userId: number, limit = 100): HistoryItem[] {
    const withdrawals = this.withdrawals.listForUser(userId, limit).map(
      (w): HistoryItem => ({ type: 'withdrawal', at: w.created_at, withdrawal: this.withdrawals.toUserDto(w) }),
    );
    const transfers = (
      this.db
        .prepare(
          // Check payouts show up under the check itself for the creator, so only direct ones go out here.
          `SELECT * FROM transfers WHERE to_user_id = ? OR (from_user_id = ? AND kind = 'direct') ORDER BY id DESC LIMIT ?`,
        )
        .all(userId, userId, limit) as unknown as TransferRow[]
    ).map((t): HistoryItem => ({ type: 'transfer', at: t.created_at, transfer: this.transferDto(t, userId) }));
    const checks = this.checksOf(userId, limit).map((c): HistoryItem => ({ type: 'check', at: c.created_at, check: this.checkDto(c) }));
    return [...withdrawals, ...transfers, ...checks].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  transferDto(t: TransferRow, viewerId: number): TransferDto {
    const direction = t.to_user_id === viewerId ? 'in' : 'out';
    return {
      id: t.id,
      direction,
      kind: t.kind,
      amountMicro: t.amount_micro,
      counterparty: this.person(direction === 'in' ? t.from_user_id : t.to_user_id),
      comment: t.comment,
      createdAt: t.created_at,
    };
  }

  checkDto(c: CheckRow): CheckDto {
    return {
      id: c.id,
      code: c.code,
      amountMicro: c.amount_micro,
      comment: c.comment,
      status: c.status,
      createdAt: c.created_at,
      claimedAt: c.claimed_at,
      claimedBy: c.claimed_by ? this.person(c.claimed_by) : null,
      link: checkLink(this.botUsername(), c.code),
    };
  }

  person(userId: number): PersonDto {
    const u = this.users.get(userId)!;
    return { username: u.username, firstName: u.first_name, photoUrl: u.photo_url };
  }

  // ---------- Internals ----------

  private amount(input: string | number): number {
    const a = parseUsdt(input);
    if (typeof a === 'string') throw new AppError(400, 'amount', a);
    return a;
  }

  private assertCanSpend(user: UserRow): void {
    if (user.blocked) throw new AppError(403, 'blocked', 'Операции недоступны. Свяжитесь с поддержкой');
    this.withdrawals.assertNotLocked(user.id);
  }

  private assertBalance(userId: number, amountMicro: number): void {
    if (this.ledger.balances(userId).availableMicro < amountMicro) throw new AppError(400, 'insufficient', 'Недостаточно средств');
  }

  private insertTransfer(from: number, to: number, amountMicro: number, kind: 'direct' | 'check', checkId: number | null, comment: string | null, requestId: string | null): number {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO transfers (from_user_id, to_user_id, amount_micro, kind, check_id, comment, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(from, to, amountMicro, kind, checkId, comment, requestId, this.now());
    return Number(lastInsertRowid);
  }
}
