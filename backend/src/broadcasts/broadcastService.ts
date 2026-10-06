import type { AdminBroadcastDto, BroadcastRequest } from '../../../shared/api.js';
import type { AuditLog } from '../audit/auditLog.js';
import { transaction, type Db } from '../db/database.js';
import type { InlineButton, Messenger, SendResult } from '../notifications/messenger.js';
import type { UserRepo } from '../users/userRepo.js';
import { AppError } from '../withdrawals/withdrawalService.js';

interface Row {
  id: number;
  created_at: number;
  author: string;
  text: string;
  photo: Uint8Array | null;
  photo_file_id: string | null;
  button_text: string | null;
  button_url: string | null;
  status: 'sending' | 'done' | 'failed';
  total: number;
  finished_at: number | null;
}

interface Prepared {
  text: string;
  photo: Uint8Array | null;
  buttonText: string | null;
  buttonUrl: string | null;
}

const MAX_PHOTO = 5 * 1024 * 1024;
/** Telegram allows ~30 messages per second to different chats; stay below. */
const PER_SECOND = 20;

/** Mass messages to every bot user: test to yourself, then send to all in the background. */
export class BroadcastService {
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly messenger: Messenger | null,
    private readonly audit: AuditLog,
    private readonly adminTelegramId: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Sends the message to the admin's own Telegram to check formatting before the real thing. */
  async test(req: BroadcastRequest): Promise<{ ok: boolean; error: string | null }> {
    const p = this.prepare(req);
    if (!this.adminTelegramId) throw new AppError(400, 'no_admin_chat', 'Укажите ADMIN_TELEGRAM_ID в настройках сервера, чтобы отправлять проверку себе');
    const res = await this.deliver(this.adminTelegramId, p, null);
    return { ok: res.ok, error: res.ok ? null : res.error };
  }

  start(req: BroadcastRequest, author = 'admin'): AdminBroadcastDto {
    const p = this.prepare(req);
    this.requireMessenger();
    const id = transaction(this.db, () => {
      const recipients = this.users.allTelegramIds();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO broadcasts (created_at, author, text, photo, button_text, button_url, status, total) VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)`,
        )
        .run(this.now(), author, p.text, p.photo, p.buttonText, p.buttonUrl, recipients.length);
      const bid = Number(lastInsertRowid);
      const ins = this.db.prepare(`INSERT INTO broadcast_deliveries (broadcast_id, user_id, status) VALUES (?, ?, 'queued')`);
      for (const r of recipients) ins.run(bid, r.id);
      this.audit.log({ actor: 'admin', type: 'broadcast_sent', data: { broadcastId: bid, recipients: recipients.length, text: p.text.slice(0, 200) } });
      return bid;
    });
    void this.run();
    return this.get(id);
  }

  /** Works through queued deliveries; also resumes an interrupted broadcast after a restart. */
  async run(): Promise<void> {
    if (this.running || !this.messenger) return;
    this.running = true;
    try {
      for (;;) {
        const b = this.db.prepare(`SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1`).get() as unknown as Row | undefined;
        if (!b) break;
        const batch = this.db
          .prepare(
            `SELECT d.user_id, u.telegram_id FROM broadcast_deliveries d JOIN users u ON u.id = d.user_id
             WHERE d.broadcast_id = ? AND d.status = 'queued' LIMIT ?`,
          )
          .all(b.id, PER_SECOND) as unknown as { user_id: number; telegram_id: number }[];
        if (!batch.length) {
          this.db.prepare(`UPDATE broadcasts SET status = 'done', finished_at = ? WHERE id = ?`).run(this.now(), b.id);
          continue;
        }
        const p: Prepared = { text: b.text, photo: b.photo, buttonText: b.button_text, buttonUrl: b.button_url };
        for (const r of batch) {
          let res = await this.deliver(r.telegram_id, p, b.photo_file_id);
          if (!res.ok && res.retryAfter) {
            await this.sleep(res.retryAfter * 1000);
            res = await this.deliver(r.telegram_id, p, b.photo_file_id);
          }
          if (res.ok && res.fileId && !b.photo_file_id && b.photo) {
            b.photo_file_id = res.fileId; // upload once, reuse for everyone else
            this.db.prepare('UPDATE broadcasts SET photo_file_id = ? WHERE id = ?').run(res.fileId, b.id);
          }
          const status = res.ok ? 'sent' : res.blocked ? 'blocked' : 'failed';
          this.db
            .prepare('UPDATE broadcast_deliveries SET status = ?, error = ?, at = ? WHERE broadcast_id = ? AND user_id = ?')
            .run(status, res.ok ? null : res.error, this.now(), b.id, r.user_id);
        }
        await this.sleep(1000);
      }
    } finally {
      this.running = false;
    }
  }

  list(): AdminBroadcastDto[] {
    const rows = this.db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 100').all() as unknown as Row[];
    return rows.map((r) => this.dto(r));
  }

  get(id: number): AdminBroadcastDto {
    const r = this.db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!r) throw new AppError(404, 'not_found', 'Рассылка не найдена');
    return this.dto(r);
  }

  private dto(r: Row): AdminBroadcastDto {
    const counts = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM broadcast_deliveries WHERE broadcast_id = ? GROUP BY status')
      .all(r.id) as unknown as { status: string; n: number }[];
    const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
    const errors = this.db
      .prepare(
        `SELECT d.user_id AS userId, u.username, d.error FROM broadcast_deliveries d JOIN users u ON u.id = d.user_id
         WHERE d.broadcast_id = ? AND d.status = 'failed' LIMIT 50`,
      )
      .all(r.id) as unknown as AdminBroadcastDto['errors'];
    return {
      id: r.id,
      createdAt: r.created_at,
      author: r.author,
      text: r.text,
      hasPhoto: !!r.photo,
      buttonText: r.button_text,
      buttonUrl: r.button_url,
      status: r.status,
      total: r.total,
      sent: n('sent'),
      failed: n('failed'),
      blocked: n('blocked'),
      finishedAt: r.finished_at,
      errors,
    };
  }

  private requireMessenger(): Messenger {
    if (!this.messenger) throw new AppError(503, 'bot_off', 'Бот не подключён: нет TELEGRAM_BOT_TOKEN');
    return this.messenger;
  }

  private deliver(chatId: number, p: Prepared, fileId: string | null): Promise<SendResult> {
    const m = this.requireMessenger();
    const buttons: InlineButton[][] = p.buttonText && p.buttonUrl ? [[{ text: p.buttonText, url: p.buttonUrl }]] : [];
    if (p.photo) return m.sendPhoto(chatId, fileId ? { fileId } : { bytes: p.photo }, p.text, { buttons, html: true });
    return m.send(chatId, p.text, { buttons, html: true });
  }

  private prepare(req: BroadcastRequest): Prepared {
    const text = String(req.text ?? '').trim();
    let photo: Uint8Array | null = null;
    if (req.photoBase64) {
      const b64 = String(req.photoBase64).replace(/^data:[^,]+,/, '');
      photo = new Uint8Array(Buffer.from(b64, 'base64'));
      if (!photo.length) throw new AppError(400, 'photo', 'Не удалось прочитать картинку');
      if (photo.length > MAX_PHOTO) throw new AppError(400, 'photo', 'Картинка больше 5 МБ');
    }
    if (!text && !photo) throw new AppError(400, 'text', 'Напишите текст сообщения');
    const limit = photo ? 1024 : 4096;
    if (text.length > limit) throw new AppError(400, 'text', `Слишком длинный текст: максимум ${limit} символов${photo ? ' с картинкой' : ''}`);
    const buttonText = String(req.buttonText ?? '').trim().slice(0, 64) || null;
    const buttonUrl = String(req.buttonUrl ?? '').trim() || null;
    if (!!buttonText !== !!buttonUrl) throw new AppError(400, 'button', 'Для кнопки нужны и текст, и ссылка');
    if (buttonUrl && !/^(https?:\/\/|tg:\/\/)/i.test(buttonUrl)) throw new AppError(400, 'button', 'Ссылка кнопки должна начинаться с https://');
    return { text, photo, buttonText, buttonUrl };
  }
}
