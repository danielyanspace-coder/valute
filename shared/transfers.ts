// Rules for free internal USDT transfers: direct (by Telegram username) and checks.

import { USDT_MICRO } from './payout.js';

export const MIN_TRANSFER_MICRO = 10_000; // 0.01 USDT
export const MAX_COMMENT_LENGTH = 100;

/**
 * "10", "10,5", "10.50", "$10", "10 usdt" → micro-USDT. Up to two decimals.
 * Returns an error message instead of a number when the input is not a valid amount.
 */
export function parseUsdt(input: string | number): number | string {
  const s = String(input).trim().replace(/^\$\s*/, '').replace(/\s*(usdt|\$)$/i, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return 'Введите сумму, например 10 или 2.5';
  if (/\.\d{3,}$/.test(s)) return 'Не больше двух знаков после точки';
  const [whole, frac = ''] = s.split('.');
  const micro = Number(whole) * USDT_MICRO + Number(frac.padEnd(6, '0'));
  if (!Number.isSafeInteger(micro)) return 'Слишком большая сумма';
  if (micro < MIN_TRANSFER_MICRO) return 'Минимум 0.01 USDT';
  return micro;
}

export function isValidUsername(input: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(normalizeUsername(input));
}

export const normalizeUsername = (input: string) => input.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');

export function cleanComment(input: string | undefined): string | null {
  const c = (input ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_COMMENT_LENGTH);
  return c || null;
}

/** Deep-link payload of a check: t.me/<bot>?start=c_<code> */
export const CHECK_START_PREFIX = 'c_';
export const checkLink = (botUsername: string, code: string) => `https://t.me/${botUsername}?start=${CHECK_START_PREFIX}${code}`;

export type InlineQuery =
  | { kind: 'empty' }
  | { kind: 'amount'; amountMicro: number; comment: string | null }
  | { kind: 'check'; code: string }
  | { kind: 'invalid'; error: string };

/**
 * What the user typed after "@bot " in any chat:
 *   ""             → help
 *   "10", "10 на кофе", "$2.5" → a new check (with optional comment)
 *   "c_AbC123"     → share an existing check (used by the "Send to chat" button in the app)
 */
export function parseInlineQuery(query: string): InlineQuery {
  const q = query.trim();
  if (!q) return { kind: 'empty' };
  const check = /^c_([A-Za-z0-9]{6,32})$/.exec(q);
  if (check) return { kind: 'check', code: check[1] };
  const m = /^\$?\s*(\d+(?:[.,]\d+)?)\s*(?:usdt|\$)?(?:\s+(.*))?$/i.exec(q);
  if (!m) return { kind: 'invalid', error: 'Начните с суммы, например: 10' };
  const amount = parseUsdt(m[1]);
  if (typeof amount === 'string') return { kind: 'invalid', error: amount };
  return { kind: 'amount', amountMicro: amount, comment: cleanComment(m[2]) };
}

/** "10", "2.5", "0.01" (no trailing zeros), for check images and short texts. */
export function shortUsdt(micro: number): string {
  const v = micro / USDT_MICRO;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
}
