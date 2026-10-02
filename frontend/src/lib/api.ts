import { tg } from './telegram';

export interface RatePoint {
  t: number;
  v: number;
}

export interface WalletRate {
  pair: 'USDT/RUB';
  /** RUB per 1 USDT when buying — shown on the home screen. */
  buyRate: number;
  /** RUB per 1 USDT when paying by SBP from the USDT balance. */
  sellRate: number;
  change24hPercent: number;
  history: RatePoint[];
  updatedAt: number;
}

export interface MarketCoin {
  symbol: string;
  priceUsd: number;
  change24hPercent: number;
}

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (tg?.initData) headers.Authorization = `tma ${tg.initData}`;
  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const IS_DEMO = import.meta.env.MODE === 'demo';

interface DemoSnapshot {
  rate: WalletRate;
  coins: MarketCoin[];
}
declare const __DEMO_SNAPSHOT__: DemoSnapshot | undefined;

export const api = IS_DEMO
  ? {
      rate: async () => __DEMO_SNAPSHOT__!.rate,
      market: async () => ({ coins: __DEMO_SNAPSHOT__!.coins }),
    }
  : {
      rate: () => get<WalletRate>('/api/rate'),
      market: () => get<{ coins: MarketCoin[] }>('/api/market'),
    };
