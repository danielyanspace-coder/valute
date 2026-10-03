// Paid services (fines, parking, Steam): the user pays in USDT, the order goes to the
// operator's "МК" queue, and the operator pays the merchant by hand.

import { formatRuPhone, normalizeRuPhone, usdtMicroForRub, validateRuPhone } from './payout.js';

export type ServiceKind = 'fine' | 'parking' | 'steam';

export type OrderStatus =
  | 'pending' // created, USDT frozen, waiting for the operator
  | 'clarify' // operator needs more information from the user; USDT stay frozen
  | 'paid' // operator paid, USDT written off
  | 'rejected'; // cancelled, USDT returned

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: 'В обработке',
  clarify: 'Требуется уточнение',
  paid: 'Оплачено',
  rejected: 'Отклонено',
};

export const SERVICE_TITLE: Record<ServiceKind, string> = {
  fine: 'Штраф ГИБДД',
  parking: 'Парковки России',
  steam: 'Пополнение Steam',
};

export type OrderAction = 'paid' | 'clarify' | 'reject';

const ORDER_TRANSITIONS: Record<OrderAction, OrderStatus[]> = {
  paid: ['pending', 'clarify'],
  clarify: ['pending', 'clarify'],
  reject: ['pending', 'clarify'],
};

export function nextOrderStatus(status: OrderStatus, action: OrderAction): OrderStatus | null {
  if (!ORDER_TRANSITIONS[action].includes(status)) return null;
  return action === 'paid' ? 'paid' : action === 'clarify' ? 'clarify' : 'rejected';
}

export const isOrderFinal = (s: OrderStatus) => s === 'paid' || s === 'rejected';

// ---------- Pricing ----------

/**
 * RUB per 1 USDT for services: the Rapira price raised so that the user pays
 * `discountPercent` less USDT than at the exchange. 1 000 ₽ at Rapira 86.50 and 10%:
 * 1000 / 86.50 = 11.56 USDT without discount, 10.40 USDT with it.
 */
export function serviceRate(rapira: number, discountPercent: number): number {
  return Math.round((rapira / (1 - discountPercent / 100)) * 100) / 100;
}

/** USDT (micro) the user pays for `rub` at the service rate. */
export const serviceMicroForRub = (rub: number, rate: number) => usdtMicroForRub(rub, rate);

/** Steam: the user enters USDT, the account receives this many whole rubles. */
export const rubForServiceMicro = (micro: number, rate: number) => Math.floor((micro / 1_000_000) * rate);

// ---------- Fines ----------

/** УИН начисления: 20 или 25 цифр. Штрафы Госавтоинспекции обычно начинаются с 188. */
export function normalizeUin(input: string): string {
  return input.replace(/\D/g, '');
}

export function validateUin(input: string): string | null {
  const d = normalizeUin(input);
  if (d.length !== 20 && d.length !== 25) return 'УИН состоит из 20 или 25 цифр';
  return null;
}

/** Fine as found by UIN. */
export interface FineInfo {
  uin: string;
  /** Full amount of the fine. */
  amountRub: number;
  /** Amount with the 50% discount for paying within 20 days, if it still applies. */
  discountedAmountRub: number | null;
  discountUntil: number | null;
  issuedAt: number | null;
  article: string | null;
  description: string | null;
}

/** What the user actually has to pay for the fine today. */
export const fineDueRub = (f: FineInfo) => f.discountedAmountRub ?? f.amountRub;

export const MIN_FINE_RUB = 1;
export const MAX_FINE_RUB = 500_000;

// ---------- Parking ----------

export const MIN_PARKING_RUB = 100;
export const MAX_PARKING_RUB = 15_000;

export function validateParkingAmount(rub: number): string | null {
  if (!Number.isInteger(rub) || rub <= 0) return 'Введите сумму';
  if (rub < MIN_PARKING_RUB) return `Минимум ${MIN_PARKING_RUB} ₽`;
  if (rub > MAX_PARKING_RUB) return `Максимум ${MAX_PARKING_RUB.toLocaleString('ru-RU')} ₽ за один платёж`;
  return null;
}

/** "Парковки России" accounts are tied to a phone number. */
export const validateParkingPhone = validateRuPhone;
export const normalizeParkingPhone = normalizeRuPhone;
export const formatParkingPhone = formatRuPhone;

// ---------- Steam ----------

export const STEAM_MIN_RUB = 500;
export const STEAM_MAX_RUB = 15_000;

/** Steam account names: 3-64 latin letters, digits and underscores. */
export function validateSteamLogin(input: string): string | null {
  const v = input.trim();
  if (!v) return 'Введите логин Steam';
  if (v.length < 3) return 'Логин слишком короткий';
  if (v.length > 64) return 'Логин слишком длинный';
  if (!/^[A-Za-z0-9_]+$/.test(v)) return 'В логине Steam только латинские буквы, цифры и _';
  return null;
}

export function validateSteamRub(rub: number): string | null {
  if (rub < STEAM_MIN_RUB) return `Минимум ${STEAM_MIN_RUB} ₽ на Steam`;
  if (rub > STEAM_MAX_RUB) return `Максимум ${STEAM_MAX_RUB.toLocaleString('ru-RU')} ₽ за один платёж`;
  return null;
}
