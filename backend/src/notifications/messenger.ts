/** One inline keyboard button: a callback to the bot, a link, or the Mini App. */
export interface InlineButton {
  text: string;
  callback?: string;
  url?: string;
  webApp?: string;
}

export type SendResult =
  | { ok: true; messageId: number; fileId?: string }
  | { ok: false; blocked: boolean; error: string; retryAfter?: number };

export interface SendOptions {
  /** undefined = the default "open wallet" button; [] = no buttons. */
  buttons?: InlineButton[][];
  /** Kept for callers; every message is sent as Telegram HTML now (escape user text with esc()). */
  html?: boolean;
}

/** Everything the services need from the bot, so tests can swap it for a fake. */
export interface Messenger {
  send(chatId: number, text: string, opts?: SendOptions): Promise<SendResult>;
  sendPhoto(chatId: number, photo: { fileId?: string; bytes?: Uint8Array }, caption: string, opts?: SendOptions): Promise<SendResult>;
  editText(chatId: number, messageId: number, text: string, buttons?: InlineButton[][]): Promise<void>;
  editButtons(chatId: number, messageId: number, buttons: InlineButton[][]): Promise<void>;
}

/** Bot API reply_markup for inline buttons. */
export function inlineMarkup(rows: InlineButton[][]) {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) =>
        b.callback ? { text: b.text, callback_data: b.callback } : b.webApp ? { text: b.text, web_app: { url: b.webApp } } : { text: b.text, url: b.url },
      ),
    ),
  };
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Bot API sender. Reports deliveries so the admin panel can show "the user blocked the bot".
 */
export class TelegramMessenger implements Messenger {
  constructor(
    private readonly token: string,
    private readonly webAppUrl: string,
    private readonly onDelivery: (chatId: number, blocked: boolean) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private markup(buttons: InlineButton[][] | undefined) {
    const rows =
      buttons ?? (this.webAppUrl ? [[{ text: 'Открыть кошелёк', webApp: this.webAppUrl }]] : []);
    if (!rows.length) return undefined;
    return inlineMarkup(rows);
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData): Promise<TgResponse<T>> {
    const isForm = body instanceof FormData;
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return (await res.json()) as TgResponse<T>;
  }

  private result(chatId: number, r: TgResponse<{ message_id: number; photo?: { file_id: string }[] }>): SendResult {
    if (r.ok && r.result) {
      this.onDelivery(chatId, false);
      const photos = r.result.photo;
      return { ok: true, messageId: r.result.message_id, fileId: photos?.[photos.length - 1]?.file_id };
    }
    const blocked = r.error_code === 403;
    if (blocked) this.onDelivery(chatId, true);
    return { ok: false, blocked, error: r.description ?? 'unknown error', retryAfter: r.parameters?.retry_after };
  }

  async send(chatId: number, text: string, opts: SendOptions = {}): Promise<SendResult> {
    try {
      const r = await this.call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: this.markup(opts.buttons),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return this.result(chatId, r);
    } catch (err) {
      return { ok: false, blocked: false, error: (err as Error).message };
    }
  }

  async sendPhoto(chatId: number, photo: { fileId?: string; bytes?: Uint8Array }, caption: string, opts: SendOptions = {}): Promise<SendResult> {
    try {
      const markup = this.markup(opts.buttons);
      let r: TgResponse<{ message_id: number; photo?: { file_id: string }[] }>;
      if (photo.fileId) {
        r = await this.call('sendPhoto', { chat_id: chatId, photo: photo.fileId, caption, reply_markup: markup, parse_mode: 'HTML' });
      } else {
        const form = new FormData();
        form.set('chat_id', String(chatId));
        form.set('caption', caption);
        form.set('parse_mode', 'HTML');
        if (markup) form.set('reply_markup', JSON.stringify(markup));
        form.set('photo', new Blob([new Uint8Array(photo.bytes ?? [])]), 'image.jpg');
        r = await this.call('sendPhoto', form);
      }
      return this.result(chatId, r);
    } catch (err) {
      return { ok: false, blocked: false, error: (err as Error).message };
    }
  }

  async editText(chatId: number, messageId: number, text: string, buttons: InlineButton[][] = []): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: this.markup(buttons) ?? { inline_keyboard: [] } }).catch(() => {});
  }

  async editButtons(chatId: number, messageId: number, buttons: InlineButton[][]): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: this.markup(buttons) ?? { inline_keyboard: [] } }).catch(() => {});
  }
}
