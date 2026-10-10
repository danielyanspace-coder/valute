import type { TelegramUser } from '../auth/telegram.js';
import { checkLink, CHECK_START_PREFIX, parseInlineQuery, shortUsdt } from '../../../shared/transfers.js';
import type { Ledger } from '../ledger/ledger.js';
import type { TransferService, CheckRow } from '../transfers/transferService.js';
import type { UserRepo } from '../users/userRepo.js';
import { userCan, type UserDealAction } from '../../../shared/deals.js';
import { inlineMarkup, type InlineButton } from '../notifications/messenger.js';
import { em, esc } from '../notifications/emoji.js';
import { notYetText, type WithdrawalService } from '../withdrawals/withdrawalService.js';

/** Thin Bot API client. */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!body.ok) throw new Error(`${method}: ${body.description}`);
    return body.result as T;
  }
}

interface Update {
  update_id: number;
  message?: { chat: { id: number; type: string }; from?: TelegramUser; text?: string; entities?: { type: string; custom_emoji_id?: string; offset: number; length: number }[] };
  inline_query?: { id: string; from: TelegramUser; query: string };
  chosen_inline_result?: { result_id: string; from: TelegramUser; inline_message_id?: string };
  callback_query?: CallbackQuery;
}

interface CallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}

export interface BotDeps {
  users: UserRepo;
  ledger: Ledger;
  transfers: TransferService;
  withdrawals: WithdrawalService;
  /** Public HTTPS address of this server (the Mini App URL). Needed for check images and the "open wallet" button. */
  publicUrl: string;
  /** Support account without "@": where locked users are sent. */
  supportUsername: string;
  /** The operator's Telegram ID: may ask the bot for custom emoji ids. */
  adminTelegramId?: number;
  log: { info: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
}

const fmtUsd = (micro: number) =>
  `$${(micro / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = (u: { username: string | null; first_name: string }) => esc(u.username ? `@${u.username}` : u.first_name);

/**
 * The wallet bot, CryptoBot-style:
 * - inline mode "@bot 10 comment" in any chat posts a check with a "Получить 10 USDT" button;
 * - the button opens the bot with /start c_<code>, which credits the check to whoever pressed it;
 * - both sides get a message, and the posted check is edited to "активирован".
 */
export class WalletBot {
  username = '';
  private offset = 0;
  private running = false;

  constructor(
    private readonly api: TelegramApi,
    private readonly deps: BotDeps,
  ) {}

  async start(): Promise<void> {
    const me = await this.api.call<{ username: string }>('getMe');
    this.username = me.username;
    await this.api
      .call('setMyCommands', { commands: [{ command: 'start', description: 'Открыть кошелёк' }, { command: 'send', description: 'Как отправить USDT' }] })
      .catch((err) => this.deps.log.error({ err }, 'setMyCommands failed'));
    this.running = true;
    void this.loop();
    this.deps.log.info({ bot: this.username }, 'bot started');
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api.call<Update[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message', 'inline_query', 'chosen_inline_result', 'callback_query'] },
          40_000,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((err) => this.deps.log.error({ err, update: u.update_id }, 'bot update failed'));
        }
      } catch (err) {
        this.deps.log.error({ err }, 'getUpdates failed');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async handle(u: Update): Promise<unknown> {
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.inline_query) return this.onInlineQuery(u.inline_query);
    if (u.chosen_inline_result) return this.onChosen(u.chosen_inline_result);
    const m = u.message;
    if (m?.text && m.from && m.chat.type === 'private') {
      const custom = (m.entities ?? []).filter((e) => e.type === 'custom_emoji' && e.custom_emoji_id);
      if (custom.length && this.deps.adminTelegramId && m.from.id === this.deps.adminTelegramId) return this.emojiIds(m.from.id, m.text, custom);
      return this.onMessage(m.from, m.text);
    }
  }

  // ---------- Private chat ----------

  private async onMessage(from: TelegramUser, text: string): Promise<unknown> {
    const user = this.deps.users.upsertFromTelegram(from);
    if (user.support_lock_at) return this.sendLock(from.id);
    const [cmd, payload = ''] = text.trim().split(/\s+/, 2);
    if (cmd === '/start' && payload.startsWith(CHECK_START_PREFIX)) return this.claim(from.id, user.id, payload.slice(CHECK_START_PREFIX.length));
    if (cmd === '/send') return this.reply(from.id, this.howToSend());
    return this.reply(from.id, this.welcome());
  }

  private welcome(): string {
    const s = this.deps.supportUsername;
    return [
      `${em('brand')} <b>Crypto IX</b>: USDT-кошелёк прямо в Telegram`,
      '',
      'Хранение, пополнение и вывод USDT без сторонних приложений и бирж.',
      '',
      '• Вывод на банковскую карту и по СБП',
      '• Пополнение USDT в сети TRC-20',
      '• Курс фиксируется в момент создания заявки',
      '• Переводы между пользователями без комиссии',
      '• Проверка входящих средств по санкционным спискам',
      '',
      `${em('point')} Откройте кошелёк, чтобы начать.`,
      ...(s ? [`Поддержка: @${s}`] : []),
    ].join('\n');
  }

  /** Operator helper: send custom emoji to the bot, get their ids for CUSTOM_EMOJI_IDS. */
  private emojiIds(chatId: number, text: string, entities: { custom_emoji_id?: string; offset: number; length: number }[]) {
    const lines = entities.map((e) => `${text.slice(e.offset, e.offset + e.length)}  <code>${e.custom_emoji_id}</code>`);
    return this.reply(chatId, `ID эмодзи для CUSTOM_EMOJI_IDS:\n${lines.join('\n')}`);
  }

  private howToSend(): string {
    return [
      `${em('point')} <b>Как отправить чек</b>`,
      `В любом чате напишите <code>@${this.username} 10</code> и выберите «Отправить чек». Получатель нажмёт «Получить», и USDT придут ему на баланс.`,
      '',
      `С комментарием: <code>@${this.username} 10 за кофе</code>`,
      'Или по username: кошелёк → «Перевести».',
    ].join('\n');
  }

  private async claim(chatId: number, userId: number, code: string): Promise<void> {
    const claimer = this.deps.users.get(userId)!;
    try {
      const { check, creator } = this.deps.transfers.claim(code, claimer);
      const comment = check.comment ? `\n${em('support')} «${esc(check.comment)}»` : '';
      await this.reply(chatId, `${em('received')} <b>Вы получили ${shortUsdt(check.amount_micro)} USDT</b> (${fmtUsd(check.amount_micro)}) от ${who(creator)}.${comment}\nСредства уже на балансе.`);
      await this.markClaimed(check, who(claimer));
    } catch (err) {
      await this.reply(chatId, `${em('warning')} ${esc((err as Error).message || 'Не удалось получить чек')}`);
    }
  }

  // ---------- Inline mode ----------

  private async onInlineQuery(q: { id: string; from: TelegramUser; query: string }): Promise<unknown> {
    const user = this.deps.users.upsertFromTelegram(q.from);
    const parsed = parseInlineQuery(q.query);
    const answer = (results: unknown[], buttonText?: string) =>
      this.api.call('answerInlineQuery', {
        inline_query_id: q.id,
        results,
        cache_time: 0,
        is_personal: true,
        ...(buttonText && this.deps.publicUrl ? { button: { text: buttonText, web_app: { url: this.deps.publicUrl } } } : {}),
      });

    if (user.support_lock_at) return answer([], 'Свяжитесь с поддержкой');
    const pending = this.deps.withdrawals.answerLock(user.id);
    if (pending) return answer([], `Сначала ответьте по заявке №${pending.withdrawalId}`);
    if (user.blocked) return answer([], 'Операции недоступны · открыть кошелёк');
    const balance = this.deps.ledger.balances(user.id).availableMicro;

    if (parsed.kind === 'empty') return answer([], `Введите сумму, например 10 · баланс ${shortUsdt(balance)} USDT`);
    if (parsed.kind === 'invalid') return answer([], parsed.error);

    if (parsed.kind === 'check') {
      const c = this.deps.transfers.checkByCode(parsed.code);
      if (!c || c.creator_id !== user.id || c.status !== 'active') return answer([], 'Чек не найден или уже активирован');
      return answer([this.checkResult(`x_${c.code}`, c.code, c.amount_micro, c.comment)]);
    }

    if (balance < parsed.amountMicro) return answer([], `Недостаточно средств · баланс ${shortUsdt(balance)} USDT`);
    const code = this.deps.transfers.createOffer(user, parsed.amountMicro, parsed.comment);
    return answer([this.checkResult(code, code, parsed.amountMicro, parsed.comment)], `Баланс ${shortUsdt(balance)} USDT · открыть кошелёк`);
  }

  private checkResult(resultId: string, code: string, amountMicro: number, comment: string | null) {
    const amount = shortUsdt(amountMicro);
    const caption = `${em('check')} <b>Чек на ${amount} USDT</b> (${fmtUsd(amountMicro)})${comment ? `\n${em('support')} «${esc(comment)}»` : ''}`;
    const reply_markup = { inline_keyboard: [[{ text: `Получить ${amount} USDT`, url: checkLink(this.username, code) }]] };
    const title = `Отправить чек на ${amount} USDT`;
    const description = comment ? `«${comment}»` : 'Получатель нажмёт «Получить», и USDT придут ему на баланс';
    if (this.deps.publicUrl) {
      const img = `${this.deps.publicUrl.replace(/\/$/, '')}/api/checks/image/${amount}.jpg`;
      return { type: 'photo', id: resultId, photo_url: img, thumbnail_url: img, photo_width: 1200, photo_height: 800, title, description, caption, parse_mode: 'HTML', reply_markup };
    }
    return { type: 'article', id: resultId, title, description, input_message_content: { message_text: caption, parse_mode: 'HTML' }, reply_markup };
  }

  private async onChosen(r: { result_id: string; inline_message_id?: string }): Promise<void> {
    if (r.result_id.startsWith('x_')) {
      const c = this.deps.transfers.checkByCode(r.result_id.slice(2));
      if (c && r.inline_message_id) this.deps.transfers.materializeOffer(c.code, r.inline_message_id);
      return;
    }
    try {
      this.deps.transfers.materializeOffer(r.result_id, r.inline_message_id);
    } catch (err) {
      // Balance changed between typing and sending: turn the posted message into a notice.
      if (r.inline_message_id) {
        await this.api
          .call('editMessageCaption', {
            inline_message_id: r.inline_message_id,
            caption: `${em('warning')} Чек не создан: ${esc((err as Error).message.toLowerCase())}.`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] },
          })
          .catch(() => {});
      }
    }
  }

  private async markClaimed(check: CheckRow, claimer: string): Promise<void> {
    if (!check.inline_message_id) return;
    await this.api
      .call('editMessageCaption', {
        inline_message_id: check.inline_message_id,
        caption: `${em('success')} Чек на <b>${shortUsdt(check.amount_micro)} USDT</b> активирован ${claimer}.`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      })
      .catch((err) => this.deps.log.error({ err }, 'edit claimed check failed'));
  }

  // ---------- Deal reminders: buttons under the bot messages ----------

  /**
   * dr = "received" (asks to confirm the amount), dy = confirmed, db = back,
   * dn = "not received", dw = "not yet" (reminders 1-4, folds the reminder away),
   * da = "other amount" without the Mini App URL.
   */
  private async onCallback(q: CallbackQuery): Promise<unknown> {
    const answer = (text?: string, alert = false) =>
      this.api.call('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
    const user = this.deps.users.upsertFromTelegram(q.from);
    const [kind, idStr] = (q.data ?? '').split(':');
    const id = Number(idStr);
    const chatId = q.message?.chat.id;
    const messageId = q.message?.message_id;
    const edit = (text: string, buttons: InlineButton[][] = []) =>
      chatId && messageId
        ? this.api.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: inlineMarkup(buttons) }).catch(() => {})
        : Promise.resolve();

    if (user.support_lock_at) {
      await answer('Свяжитесь с поддержкой', true);
      return this.sendLock(q.from.id);
    }
    if (!['dr', 'dy', 'db', 'dn', 'dw', 'da'].includes(kind) || !Number.isInteger(id)) return answer();

    let w;
    try {
      w = this.deps.withdrawals.getForUser(user.id, id);
    } catch {
      return answer('Заявка не найдена', true);
    }
    const now = Date.now();
    const timing = { status: w.status, enteredAt: w.entered_at };
    const can = (a: UserDealAction) => userCan(timing, a, now);
    const sum = `${w.amount_rub.toLocaleString('ru-RU')} ₽`;
    const stale = async () => {
      await answer('Сделка уже обновилась, актуальное состояние в кошельке', true);
      return edit(`${em('pending')} <b>Заявка №${w.id}</b>: актуальное состояние смотрите в кошельке.`, this.openWallet());
    };

    try {
      switch (kind) {
        case 'dr':
          if (!can('received')) return stale();
          await answer();
          return edit(`${em('usdt')} <b>Вам поступила сумма ${sum}</b> по заявке №${w.id}?`, [
            [{ text: `Да, ${sum} поступили`, callback: `dy:${w.id}` }],
            [{ text: 'Назад', callback: `db:${w.id}` }],
          ]);
        case 'db': {
          if (!userCan(timing, 'received', now)) return stale();
          await answer();
          const msg = this.deps.withdrawals.reminder(Math.max(1, w.reminders_sent), w);
          return edit(msg.text, this.deps.withdrawals.dealButtons(w, msg.receivedLabel));
        }
        case 'dy':
          this.deps.withdrawals.userReceived(user.id, w.id);
          await answer('Спасибо! Получение подтверждено');
          return edit(`${em('success')} <b>Заявка №${w.id}</b>: получение ${sum} подтверждено. Спасибо!`);
        case 'dn':
          this.deps.withdrawals.userNotReceived(user.id, w.id);
          await answer('С вами свяжется поддержка');
          return edit(`${em('support')} <b>Заявка №${w.id}</b>: вы сообщили, что оплата не поступила. С вами свяжется поддержка. Если деньги придут, подтвердите получение в кошельке.`, this.openWallet());
        case 'dw':
          this.deps.withdrawals.userNotYet(user.id, w.id);
          await answer('Хорошо, ждём. Подтвердите, когда деньги придут');
          return edit(notYetText(w), this.openWallet());
        case 'da':
          return answer('Откройте кошелёк и укажите сумму, которая поступила', true);
      }
    } catch (err) {
      await answer((err as Error).message || 'Не удалось выполнить действие', true);
      return edit(`${em('pending')} <b>Заявка №${w.id}</b>: актуальное состояние смотрите в кошельке.`, this.openWallet());
    }
  }

  private openWallet(): InlineButton[][] {
    return this.deps.publicUrl ? [[{ text: 'Открыть кошелёк', webApp: this.deps.publicUrl }]] : [];
  }

  private sendLock(chatId: number) {
    const s = this.deps.supportUsername;
    return this.api.call('sendMessage', {
      chat_id: chatId,
      text: `${em('lock')} <b>Свяжитесь с поддержкой</b>\nОперации в кошельке приостановлены до связи с нами.`,
      parse_mode: 'HTML',
      ...(s ? { reply_markup: inlineMarkup([[{ text: 'Написать в поддержку', url: `https://t.me/${s}` }]]) } : {}),
    });
  }

  private reply(chatId: number, text: string) {
    const markup = this.deps.publicUrl ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть кошелёк', web_app: { url: this.deps.publicUrl } }]] } } : {};
    return this.api.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup });
  }
}
