import type { NotificationType } from '../../../shared/api.js';
import type { Db } from '../db/database.js';
import type { InlineButton } from './messenger.js';

export interface BotSender {
  send(telegramId: number, text: string, opts?: { buttons?: InlineButton[][] }): Promise<unknown>;
}

export interface NotifyRef {
  withdrawalId?: number;
  transferId?: number;
  checkId?: number;
  orderId?: number;
  depositId?: number;
  usdtPayoutId?: number;
  obligationId?: number;
  amountMicro?: number;
  /** Bot message text. null or missing = in-app only. */
  botText?: string | null;
  /** Bot buttons; default is "open wallet". */
  buttons?: InlineButton[][];
}

export interface StoredNotification {
  id: number;
  type: NotificationType;
  withdrawalId: number | null;
  transferId: number | null;
  checkId: number | null;
  orderId: number | null;
  depositId: number | null;
  usdtPayoutId: number | null;
  obligationId: number | null;
  amountMicro: number | null;
  createdAt: number;
}

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

  notify(user: { id: number; telegram_id: number }, type: NotificationType, r: NotifyRef = {}): void {
    this.db
      .prepare(
        `INSERT INTO notifications (user_id, type, withdrawal_id, transfer_id, check_id, order_id, deposit_id, usdt_payout_id, obligation_id, amount_micro, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id, type, r.withdrawalId ?? null, r.transferId ?? null, r.checkId ?? null, r.orderId ?? null, r.depositId ?? null,
        r.usdtPayoutId ?? null, r.obligationId ?? null, r.amountMicro ?? null, this.now(),
      );
    if (this.bot && r.botText) this.bot.send(user.telegram_id, r.botText, { buttons: r.buttons }).catch(this.onError);
  }

  /** Bot message only, no in-app modal. */
  botOnly(user: { telegram_id: number }, text: string, buttons?: InlineButton[][]): void {
    if (this.bot) this.bot.send(user.telegram_id, text, { buttons }).catch(this.onError);
  }

  unseen(userId: number): StoredNotification[] {
    return this.db
      .prepare(
        `SELECT id, type, withdrawal_id AS withdrawalId, transfer_id AS transferId, check_id AS checkId, order_id AS orderId, deposit_id AS depositId,
                usdt_payout_id AS usdtPayoutId, obligation_id AS obligationId, amount_micro AS amountMicro, created_at AS createdAt
         FROM notifications WHERE user_id = ? AND seen_at IS NULL ORDER BY id`,
      )
      .all(userId) as unknown as StoredNotification[];
  }

  markSeen(userId: number, ids: number[]): void {
    const stmt = this.db.prepare('UPDATE notifications SET seen_at = ? WHERE id = ? AND user_id = ?');
    for (const id of ids) stmt.run(this.now(), id, userId);
  }
}

