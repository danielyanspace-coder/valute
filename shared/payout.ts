// Rules for ruble payouts (withdrawal to a Russian bank card or via SBP).
// Shared by the Mini App (instant validation) and the backend (authoritative checks).

export const MIN_PAYOUT_RUB = 500;
export const PAYOUT_STEP_RUB = 100;
/** How long the user has to confirm receipt after the admin marks the payment as sent. */
export const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
export const USDT_MICRO = 1_000_000;

export type PayoutMethod = 'sbp' | 'card';

export type WithdrawalStatus =
  | 'pending' // created, USDT frozen, waiting for the operator to pay
  | 'sent' // operator paid, waiting for the user to confirm receipt
  | 'disputed' // user says the money did not arrive
  | 'completed' // receipt confirmed (user, auto or admin), USDT written off
  | 'rejected'; // cancelled by the operator, USDT returned to the balance

export type WithdrawalAction =
  | 'mark_sent'
  | 'confirm_user'
  | 'confirm_auto'
  | 'confirm_admin'
  | 'dispute'
  | 'reject';

const TRANSITIONS: Record<WithdrawalAction, { from: WithdrawalStatus[]; to: WithdrawalStatus }> = {
  // Re-sending after a dispute restarts the confirmation window.
  mark_sent: { from: ['pending', 'disputed'], to: 'sent' },
  confirm_user: { from: ['sent'], to: 'completed' },
  confirm_auto: { from: ['sent'], to: 'completed' },
  // The operator can close the deal even if the user reported a missing payment.
  confirm_admin: { from: ['sent', 'disputed'], to: 'completed' },
  dispute: { from: ['sent'], to: 'disputed' },
  reject: { from: ['pending', 'disputed'], to: 'rejected' },
};

export function nextStatus(status: WithdrawalStatus, action: WithdrawalAction): WithdrawalStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(status) ? t.to : null;
}

export const isFinal = (s: WithdrawalStatus) => s === 'completed' || s === 'rejected';

export const STATUS_LABEL: Record<WithdrawalStatus, string> = {
  pending: 'В обработке',
  sent: 'Ждёт подтверждения',
  disputed: 'Проверяем платёж',
  completed: 'Выполнено',
  rejected: 'Отклонено',
};

// ---------- Phone (SBP) ----------

/** Digits only, normalised to 11 digits starting with 7. Accepts +7, 7 or 8 prefixes. */
export function normalizeRuPhone(input: string): string {
  const d = input.replace(/\D/g, '');
  if (/^\s*\+/.test(input)) return d; // "+7…" is already international
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) return '7' + d.slice(1);
  if (d.length === 10) return '7' + d;
  return d;
}

/** SBP transfers go to Russian mobile numbers: +7 9XX XXX XX XX. */
export function validateRuPhone(input: string): string | null {
  const d = normalizeRuPhone(input);
  if (d.length !== 11 || d[0] !== '7') return 'Введите номер полностью: +7 9XX XXX-XX-XX';
  if (d[1] !== '9') return 'Нужен мобильный номер, он начинается с +7 9';
  return null;
}

/** "+7 912 345-67-89", formats partial input too (for the input mask). */
export function formatRuPhone(input: string): string {
  let d = input.replace(/\D/g, '');
  if (d[0] === '8' || d[0] === '7') d = d.slice(1);
  d = d.slice(0, 10);
  let out = '+7';
  if (d.length > 0) out += ' ' + d.slice(0, 3);
  if (d.length > 3) out += ' ' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 8);
  if (d.length > 8) out += '-' + d.slice(8, 10);
  return out;
}

// ---------- Card ----------

export type CardBrand = 'mir' | 'visa' | 'mastercard' | 'unionpay' | 'unknown';

export function cardBrand(digits: string): CardBrand {
  if (/^220[0-4]/.test(digits)) return 'mir';
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard';
  if (/^62/.test(digits)) return 'unionpay';
  return 'unknown';
}

export const CARD_BRAND_LABEL: Record<CardBrand, string> = {
  mir: 'МИР',
  visa: 'Visa',
  mastercard: 'Mastercard',
  unionpay: 'UnionPay',
  unknown: '',
};

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export function validateCard(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length < 16) return 'Номер карты состоит из 16 цифр';
  if (d.length > 19) return 'Слишком длинный номер карты';
  if (!luhnValid(d)) return 'Проверьте номер, в нём ошибка';
  if (cardBrand(d) === 'unknown') return 'Поддерживаются карты МИР, Visa, Mastercard и UnionPay';
  return null;
}

/** "2200 1234 5678 9010" */
export const formatCard = (input: string) =>
  input.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');

/** "•• 9010" */
export const maskCard = (digits: string) => `•• ${digits.slice(-4)}`;

// ---------- Amount ----------

export function validatePayoutRub(amount: number, availableRub?: number): string | null {
  if (!Number.isInteger(amount) || amount <= 0) return 'Введите сумму';
  if (amount < MIN_PAYOUT_RUB) return `Минимальная сумма ${MIN_PAYOUT_RUB} ₽`;
  if (amount % PAYOUT_STEP_RUB !== 0) return `Сумма должна быть кратна ${PAYOUT_STEP_RUB} ₽`;
  if (availableRub !== undefined && amount > availableRub) return 'Недостаточно средств';
  return null;
}

/**
 * USDT (in micro units, 6 decimals) needed to pay out `rub` at `rate` RUB per USDT.
 * Integer maths on kopecks so 8 223 ₽ at 82.23 is exactly 100 USDT; any remainder rounds up.
 */
export function usdtMicroForRub(rub: number, rate: number): number {
  const rateKop = BigInt(Math.round(rate * 100));
  const num = BigInt(rub) * 100n * BigInt(USDT_MICRO);
  return Number((num + rateKop - 1n) / rateKop);
}

/** Largest payout (multiple of the step) that fits into the available USDT. */
export function maxPayoutRub(availableMicro: number, rate: number): number {
  const rub = Math.floor((availableMicro / USDT_MICRO) * rate);
  let max = rub - (rub % PAYOUT_STEP_RUB);
  while (max > 0 && usdtMicroForRub(max, rate) > availableMicro) max -= PAYOUT_STEP_RUB;
  return max;
}

export const microToUsdt = (micro: number) => micro / USDT_MICRO;
