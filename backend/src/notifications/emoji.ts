// Emoji in bot messages. Plain Unicode emoji by default; Telegram's animated custom emoji
// when CUSTOM_EMOJI=on and an id is set for the key. Bots can send custom emoji only after
// a collectible username from Fragment is attached to the bot; until then the plain one shows.

export const EMOJI = {
  deposit: '💰',
  received: '📥',
  withdraw: '💸',
  success: '✅',
  cancel: '❌',
  pending: '⏳',
  clock: '⏰',
  warning: '⚠️',
  urgent: '❗️',
  critical: '🚨',
  check: '🎟',
  usdt: '💵',
  lock: '🔒',
  unlock: '🔓',
  support: '💬',
  hold: '❄️',
  brand: '◾️',
  point: '▪️',
  gift: '🎁',
} as const;

export type EmojiKey = keyof typeof EMOJI;

let enabled = false;
let ids: Partial<Record<EmojiKey, string>> = {};

/** CUSTOM_EMOJI_IDS="deposit=5368324170671202286,success=5370869711888194012". Unknown keys and bad ids are ignored. */
export function configureEmoji(on: boolean, spec: string): void {
  enabled = on;
  ids = {};
  for (const pair of spec.split(/[,\s]+/)) {
    const [key, id] = pair.split('=');
    if (key in EMOJI && /^\d{5,25}$/.test(id ?? '')) ids[key as EmojiKey] = id;
  }
}

/** HTML for one emoji: animated custom emoji when configured, the plain one otherwise. */
export function em(key: EmojiKey): string {
  const id = enabled ? ids[key] : undefined;
  return id ? `<tg-emoji emoji-id="${id}">${EMOJI[key]}</tg-emoji>` : EMOJI[key];
}

/** Everything that comes from users or admins goes through this before landing in an HTML message. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
