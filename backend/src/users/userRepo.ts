import type { TelegramUser } from '../auth/telegram.js';
import type { Db } from '../db/database.js';

export interface UserRow {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string;
  last_name: string | null;
  photo_url: string | null;
  language_code: string | null;
  blocked: number;
  missed_confirmations: number;
  created_at: number;
  last_seen_at: number;
}

export class UserRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates the user on first visit and keeps the Telegram profile fresh (username can change or be hidden). */
  upsertFromTelegram(tg: TelegramUser): UserRow {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, language_code, created_at, last_seen_at)
         VALUES (:tid, :username, :first, :last, :photo, :lang, :now, :now)
         ON CONFLICT (telegram_id) DO UPDATE SET
           username = excluded.username, first_name = excluded.first_name, last_name = excluded.last_name,
           photo_url = excluded.photo_url, language_code = excluded.language_code, last_seen_at = excluded.last_seen_at`,
      )
      .run({
        tid: tg.id,
        username: tg.username ?? null,
        first: tg.first_name,
        last: tg.last_name ?? null,
        photo: tg.photo_url ?? null,
        lang: tg.language_code ?? null,
        now,
      });
    return this.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tg.id) as unknown as UserRow;
  }

  get(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  }

  /** Case-insensitive; only users who opened the wallet or the bot at least once are known. */
  findByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as unknown as UserRow | undefined;
  }

  setBlocked(id: number, blocked: boolean): void {
    this.db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
  }

  incrementMissedConfirmations(id: number): void {
    this.db.prepare('UPDATE users SET missed_confirmations = missed_confirmations + 1 WHERE id = ?').run(id);
  }

  depositAddresses(userId: number): { chain: string; address: string; createdAt: number }[] {
    return this.db
      .prepare('SELECT chain, address, created_at AS createdAt FROM deposit_addresses WHERE user_id = ? ORDER BY chain')
      .all(userId) as unknown as { chain: string; address: string; createdAt: number }[];
  }
}
