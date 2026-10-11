import { randomInt } from 'node:crypto';
import type { AdminGiveawayDto, CreateGiveawayRequest, GiveawayDto } from '../../../shared/api.js';
import { USDT_MICRO } from '../../../shared/payout.js';
import { shortUsdt } from '../../../shared/transfers.js';
import type { AuditLog } from '../audit/auditLog.js';
import { transaction, type Db } from '../db/database.js';
import type { Ledger } from '../ledger/ledger.js';
import { em, esc } from '../notifications/emoji.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { UserRepo, UserRow } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';

interface GiveawayRow {
  id: number;
  title: string;
  prize_micro: number;
  winners: number;
  ends_at: number;
  status: 'active' | 'drawn' | 'cancelled';
  created_at: number;
  drawn_at: number | null;
}

const MAX_WINNERS = 1000;
/** How long a finished giveaway stays on the home screen with its results. */
const SHOW_RESULTS_MS = 3 * 86_400_000;

/** "Сергей К." style: first name and the initial of the last name, never the username. */
function maskName(first: string, last: string | null): string {
  return last ? `${first} ${last.slice(0, 1)}.` : first;
}

/**
 * Free giveaways: any user joins with one tap, nothing to buy or pay. IX Black does not
 * change the odds, which keeps this a promotion and not a lottery. The operator sets the
 * prize fund and draws the winners; prizes are split equally and credited to the balance.
 */
export class GiveawayService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly users: UserRepo,
    private readonly notifications: NotificationService,
    private readonly audit?: AuditLog,
    private readonly now: () => number = Date.now,
  ) {}

  private row(id: number): GiveawayRow | null {
    return (this.db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as unknown as GiveawayRow | undefined) ?? null;
  }

  private participants(id: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?').get(id) as { n: number }).n;
  }

  /** The giveaway shown on the home screen: the active one, or the latest results for a few days. */
  current(userId: number): GiveawayDto | null {
    const g = this.db
      .prepare(`SELECT * FROM giveaways WHERE status = 'active' OR (status = 'drawn' AND drawn_at > ?) ORDER BY status = 'active' DESC, id DESC LIMIT 1`)
      .get(this.now() - SHOW_RESULTS_MS) as unknown as GiveawayRow | undefined;
    return g ? this.toUserDto(g, userId) : null;
  }

  private toUserDto(g: GiveawayRow, userId: number): GiveawayDto {
    const results = this.db
      .prepare(
        `SELECT w.user_id AS userId, w.prize_micro AS prizeMicro, u.first_name AS firstName, u.last_name AS lastName
         FROM giveaway_winners w JOIN users u ON u.id = w.user_id WHERE w.giveaway_id = ? ORDER BY u.first_name LIMIT 100`,
      )
      .all(g.id) as unknown as { userId: number; prizeMicro: number; firstName: string; lastName: string | null }[];
    return {
      id: g.id,
      title: g.title,
      prizeMicro: g.prize_micro,
      winners: g.winners,
      endsAt: g.ends_at,
      status: g.status,
      participants: this.participants(g.id),
      joined: !!this.db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').get(g.id, userId),
      results: results.map((r) => ({ name: maskName(r.firstName, r.lastName), prizeMicro: r.prizeMicro, you: r.userId === userId })),
    };
  }

  join(user: UserRow, id: number): GiveawayDto {
    const g = this.row(id);
    if (!g || g.status !== 'active') throw new AppError(404, 'not_found', 'Розыгрыш не найден');
    if (g.ends_at <= this.now()) throw new AppError(400, 'ended', 'Приём участников закончился');
    if (user.blocked) throw new AppError(403, 'blocked', 'Участие недоступно. Свяжитесь с поддержкой');
    this.db.prepare('INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id, created_at) VALUES (?, ?, ?)').run(id, user.id, this.now());
    return this.toUserDto(g, user.id);
  }

  // ---------- admin ----------

  list(): AdminGiveawayDto[] {
    const rows = this.db.prepare('SELECT * FROM giveaways ORDER BY id DESC LIMIT 50').all() as unknown as GiveawayRow[];
    return rows.map((g) => this.toAdminDto(g));
  }

  private toAdminDto(g: GiveawayRow): AdminGiveawayDto {
    const results = this.db
      .prepare(
        `SELECT w.user_id AS userId, w.prize_micro AS prizeMicro, u.first_name AS firstName, u.last_name AS lastName, u.username
         FROM giveaway_winners w JOIN users u ON u.id = w.user_id WHERE w.giveaway_id = ?`,
      )
      .all(g.id) as unknown as { userId: number; prizeMicro: number; firstName: string; lastName: string | null; username: string | null }[];
    return {
      id: g.id,
      title: g.title,
      prizeMicro: g.prize_micro,
      winners: g.winners,
      endsAt: g.ends_at,
      status: g.status,
      participants: this.participants(g.id),
      createdAt: g.created_at,
      drawnAt: g.drawn_at,
      results: results.map((r) => ({ userId: r.userId, name: [r.firstName, r.lastName].filter(Boolean).join(' '), username: r.username, prizeMicro: r.prizeMicro })),
    };
  }

  create(req: CreateGiveawayRequest): AdminGiveawayDto {
    const title = String(req?.title ?? '').trim().slice(0, 80);
    const prize = Math.round(Number(req?.prizeUsdt) * USDT_MICRO);
    const winners = Math.floor(Number(req?.winners));
    const endsAt = Number(req?.endsAt);
    if (!title) throw new AppError(400, 'title', 'Укажите название');
    if (!Number.isFinite(prize) || prize <= 0) throw new AppError(400, 'prize', 'Укажите призовой фонд');
    if (!Number.isFinite(winners) || winners < 1 || winners > MAX_WINNERS) throw new AppError(400, 'winners', `Победителей от 1 до ${MAX_WINNERS}`);
    if (prize / winners < USDT_MICRO / 100) throw new AppError(400, 'prize', 'Приз на победителя меньше 0.01 USDT');
    if (!Number.isFinite(endsAt) || endsAt <= this.now()) throw new AppError(400, 'ends_at', 'Дата окончания должна быть в будущем');
    if (this.db.prepare(`SELECT 1 FROM giveaways WHERE status = 'active'`).get()) throw new AppError(409, 'active_exists', 'Уже идёт розыгрыш. Проведите или отмените его');
    const res = this.db
      .prepare(`INSERT INTO giveaways (title, prize_micro, winners, ends_at, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`)
      .run(title, prize, winners, endsAt, this.now());
    const id = Number(res.lastInsertRowid);
    this.audit?.log({ actor: 'admin', type: 'giveaway_created', amountMicro: prize, data: { giveawayId: id, title, winners, endsAt } });
    return this.toAdminDto(this.row(id)!);
  }

  cancel(id: number): AdminGiveawayDto {
    const g = this.row(id);
    if (!g || g.status !== 'active') throw new AppError(400, 'state', 'Отменить можно только идущий розыгрыш');
    this.db.prepare(`UPDATE giveaways SET status = 'cancelled' WHERE id = ?`).run(id);
    this.audit?.log({ actor: 'admin', type: 'giveaway_cancelled', data: { giveawayId: id } });
    return this.toAdminDto(this.row(id)!);
  }

  /** Picks winners uniformly with a cryptographic RNG and credits equal shares. Only after the end time. */
  draw(id: number): AdminGiveawayDto {
    const won = transaction(this.db, () => {
      const g = this.row(id);
      if (!g || g.status !== 'active') throw new AppError(400, 'state', 'Розыгрыш уже проведён или отменён');
      if (g.ends_at > this.now()) throw new AppError(400, 'not_ended', 'Розыгрыш ещё идёт. Провести можно после даты окончания');
      // Blocked accounts stay out of the draw.
      const pool = (
        this.db
          .prepare('SELECT e.user_id AS id FROM giveaway_entries e JOIN users u ON u.id = e.user_id WHERE e.giveaway_id = ? AND u.blocked = 0 ORDER BY e.user_id')
          .all(id) as unknown as { id: number }[]
      ).map((r) => r.id);
      if (!pool.length) throw new AppError(400, 'empty', 'Нет участников');
      const n = Math.min(g.winners, pool.length);
      // Partial Fisher-Yates: the first n slots become a uniform random sample.
      for (let i = 0; i < n; i++) {
        const j = i + randomInt(pool.length - i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const share = Math.floor(g.prize_micro / n);
      const winners = pool.slice(0, n);
      for (const userId of winners) {
        this.db.prepare('INSERT INTO giveaway_winners (giveaway_id, user_id, prize_micro) VALUES (?, ?, ?)').run(id, userId, share);
        this.ledger.post([{ userId, bucket: 'available', amountMicro: share, kind: 'giveaway_prize', refType: 'giveaway', refId: id }]);
      }
      this.db.prepare(`UPDATE giveaways SET status = 'drawn', drawn_at = ? WHERE id = ?`).run(this.now(), id);
      this.audit?.log({ actor: 'admin', type: 'giveaway_drawn', amountMicro: share * n, data: { giveawayId: id, participants: pool.length, winners } });
      return { title: g.title, share, winners };
    });
    for (const userId of won.winners) {
      const user = this.users.get(userId);
      if (!user) continue;
      this.notifications.notify(user, 'giveaway_won', {
        amountMicro: won.share,
        botText: `${em('gift')} <b>Вы выиграли в розыгрыше «${esc(won.title)}»</b>\n\n+${shortUsdt(won.share)} USDT уже на балансе.`,
      });
    }
    return this.toAdminDto(this.row(id)!);
  }
}
