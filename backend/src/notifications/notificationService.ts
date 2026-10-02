import type { NotificationDto, NotificationType } from '../../../shared/api.js';
import type { Db } from '../db/database.js';

export interface BotSender {
  send(telegramId: number, text: string): Promise<void>;
}

const BOT_TEXT: Record<NotificationType, (amount: string) => string> = {
  confirm_receipt: (a) => `Мы отправили ${a}. Проверьте поступление и подтвердите получение в кошельке в течение 10 минут.`,
  contact_support: (a) => `По вашему выводу ${a} нужна связь с вами. Ваш username в Telegram скрыт, поэтому напишите, пожалуйста, в поддержку сами.`,
  withdrawal_completed: (a) => `Вывод ${a} выполнен.`,
  withdrawal_rejected: (a) => `Заявка на вывод ${a} отклонена. Средства вернулись на баланс.`,
};

/**
 * In-app notifications (the Mini App polls them and shows a modal) plus a
 * duplicate message from the bot, so the user notices even with the app closed.
 */
export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly bot: BotSender | null,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  notify(user: { id: number; telegram_id: number }, type: NotificationType, withdrawal?: { id: number; amount_rub: number }): void {
    this.db
      .prepare('INSERT INTO notifications (user_id, type, withdrawal_id, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, type, withdrawal?.id ?? null, this.now());
    if (this.bot) {
      const amount = withdrawal ? `${withdrawal.amount_rub.toLocaleString('ru-RU')} ₽` : '';
      this.bot.send(user.telegram_id, BOT_TEXT[type](amount)).catch(this.onError);
    }
  }

  unseen(userId: number): NotificationDto[] {
    return this.db
      .prepare(
        `SELECT id, type, withdrawal_id AS withdrawalId, created_at AS createdAt
         FROM notifications WHERE user_id = ? AND seen_at IS NULL ORDER BY id`,
      )
      .all(userId) as unknown as NotificationDto[];
  }

  markSeen(userId: number, ids: number[]): void {
    const stmt = this.db.prepare('UPDATE notifications SET seen_at = ? WHERE id = ? AND user_id = ?');
    for (const id of ids) stmt.run(this.now(), id, userId);
  }
}

/** Sends plain messages through the Bot API; adds an "open wallet" button when the Mini App URL is known. */
export class TelegramBotSender implements BotSender {
  constructor(
    private readonly token: string,
    private readonly webAppUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(telegramId: number, text: string): Promise<void> {
    const body: Record<string, unknown> = { chat_id: telegramId, text };
    if (this.webAppUrl) {
      body.reply_markup = { inline_keyboard: [[{ text: 'Открыть кошелёк', web_app: { url: this.webAppUrl } }]] };
    }
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    // 403 = the user never started the bot; the in-app notification still works.
    if (!res.ok && res.status !== 403) throw new Error(`Bot API ${res.status}: ${await res.text()}`);
  }
}
