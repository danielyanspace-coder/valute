// Withdrawal of USDT to an external TRON (TRC-20) wallet. The operator sends it by hand
// from their own wallet and enters the transaction hash; the server checks it on chain.

import { USDT_MICRO } from './payout.js';

/**
 * new       waiting for the operator, USDT (amount + fee) frozen
 * sent      the operator sent it, the tx hash is known
 * rejected  refused, USDT back on the balance
 */
export type UsdtPayoutStatus = 'new' | 'sent' | 'rejected';

export const USDT_PAYOUT_STATUS_LABEL: Record<UsdtPayoutStatus, string> = {
  new: 'В обработке',
  sent: 'Отправлено',
  rejected: 'Отклонено',
};

/** Amount the recipient gets; the fee comes on top of it. Error text or null. */
export function validateUsdtPayout(amountMicro: number, availableMicro: number, feeMicro: number, minMicro: number): string | null {
  if (amountMicro < minMicro) return `Минимум ${minMicro / USDT_MICRO} USDT`;
  if (amountMicro + feeMicro > availableMicro) {
    const max = Math.max(0, availableMicro - feeMicro);
    return max >= minMicro ? `Доступно к выводу ${Math.floor(max / 10_000) / 100} USDT с учётом комиссии` : 'Недостаточно средств с учётом комиссии';
  }
  return null;
}

/** Most a user can send: balance minus the fee, rounded down to cents. */
export const maxUsdtPayoutMicro = (availableMicro: number, feeMicro: number) =>
  Math.max(0, Math.floor((availableMicro - feeMicro) / 10_000) * 10_000);
