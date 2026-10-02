import { describe, expect, it } from 'vitest';
import { applyDiscount, applyMarkup, RateService } from './rateService.js';
import type { RapiraTicker } from './rapira.js';

const ticker = (symbol: string, p: Partial<RapiraTicker>): RapiraTicker => ({
  symbol, open: 0, high: 0, low: 0, close: 0, chg: 0, lastDayClose: 0, askPrice: 0, bidPrice: 0, ...p,
});

describe('applyMarkup', () => {
  it('adds percent and rounds to kopecks', () => {
    expect(applyMarkup(86.5, 5)).toBe(90.83);
    expect(applyMarkup(100, 0)).toBe(100);
  });
});

describe('applyDiscount', () => {
  it('subtracts percent and rounds to kopecks', () => {
    expect(applyDiscount(86.47, 5)).toBe(82.15);
  });
});

describe('RateService', () => {
  it('builds wallet rate from Rapira ask price + markup', async () => {
    const svc = new RateService({ walletMarkupPercent: 5, qrPayDiscountPercent: 5 }, async () => [
      ticker('USDT/RUB', { askPrice: 86.5, bidPrice: 86.47, open: 86.42, low: 85.86, high: 86.64, close: 86.5, chg: 0.00093 }),
      ticker('BTC/USDT', { close: 84945.5, chg: 0.0044 }),
    ], () => 1_000_000_000);
    expect(svc.getWalletRate()).toBeNull();
    await svc.refresh();
    const rate = svc.getWalletRate()!;
    expect(rate.exchangeAsk).toBe(86.5);
    expect(rate.walletRate).toBe(90.83);
    expect(rate.qrPayRate).toBe(82.15);
    expect(rate.change24hPercent).toBe(0.09);
    expect(rate.history.at(-1)!.v).toBe(90.83);
    expect(svc.getMarket()).toEqual([
      { symbol: 'BTC', priceUsd: 84945.5, change24hPercent: 0.44 },
      { symbol: 'USDT', priceUsd: 1, change24hPercent: 0 },
    ]);
  });

  it('keeps one history point per 5-minute bucket', async () => {
    let now = 0;
    let ask = 80;
    const svc = new RateService({ walletMarkupPercent: 0, qrPayDiscountPercent: 0 }, async () => [ticker('USDT/RUB', { askPrice: ask })], () => now);
    for (let i = 0; i < 30; i++) {
      now = i * 60_000;
      ask = 80 + i;
      await svc.refresh();
    }
    const own = svc.getWalletRate()!.history.slice(3); // drop 3 seed points
    expect(own).toHaveLength(6);
    expect(own.at(-1)!.v).toBe(109);
  });
});
