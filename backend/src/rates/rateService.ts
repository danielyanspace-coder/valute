import { fetchRapiraTickers, type RapiraTicker } from './rapira.js';

export interface RatePoint {
  t: number;
  v: number;
}

export interface RateMargins {
  /** Added to Rapira ask when the user buys USDT (deposit, balance display). */
  buyMarkupPercent: number;
  /** Taken off Rapira bid when the user spends USDT for rubles (SBP payments). */
  sellDiscountPercent: number;
}

export interface WalletRate extends RateMargins {
  pair: 'USDT/RUB';
  /** Rapira ask price — what it costs to buy 1 USDT on the exchange. */
  exchangeAsk: number;
  /** Rapira bid price — what the exchange pays for 1 USDT. */
  exchangeBid: number;
  /** RUB per 1 USDT when the user buys: ask * (1 + buyMarkup). Shown on the home screen. */
  buyRate: number;
  /** RUB per 1 USDT when the user pays in rubles: bid * (1 - sellDiscount). */
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

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_STEP_MS = 5 * 60 * 1000;
const MARKET_SYMBOLS = ['BTC', 'ETH', 'USDT', 'SOL'] as const;

export function applyMarkup(price: number, markupPercent: number): number {
  return round2(price * (1 + markupPercent / 100));
}

export function applyDiscount(price: number, discountPercent: number): number {
  return round2(price * (1 - discountPercent / 100));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class RateService {
  private tickers = new Map<string, RapiraTicker>();
  private history: RatePoint[] = [];
  private updatedAt = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly margins: RateMargins,
    private readonly fetchTickers: () => Promise<RapiraTicker[]> = () => fetchRapiraTickers(),
    private readonly now: () => number = Date.now,
  ) {}

  async refresh(): Promise<void> {
    const tickers = await this.fetchTickers();
    for (const t of tickers) this.tickers.set(t.symbol, t);
    this.updatedAt = this.now();

    const usdt = this.tickers.get('USDT/RUB');
    if (usdt) this.recordHistory(applyMarkup(usdt.askPrice, this.margins.buyMarkupPercent));
  }

  start(intervalMs: number, onError: (err: unknown) => void): Promise<void> {
    const tick = () => this.refresh().catch(onError);
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    return tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  getWalletRate(): WalletRate | null {
    const usdt = this.tickers.get('USDT/RUB');
    if (!usdt) return null;
    return {
      pair: 'USDT/RUB',
      ...this.margins,
      exchangeAsk: usdt.askPrice,
      exchangeBid: usdt.bidPrice,
      buyRate: applyMarkup(usdt.askPrice, this.margins.buyMarkupPercent),
      sellRate: applyDiscount(usdt.bidPrice, this.margins.sellDiscountPercent),
      change24hPercent: round2(usdt.chg * 100),
      history: this.historyWithSeed(usdt),
      updatedAt: this.updatedAt,
    };
  }

  getMarket(): MarketCoin[] {
    return MARKET_SYMBOLS.flatMap((symbol): MarketCoin[] => {
      if (symbol === 'USDT') return [{ symbol, priceUsd: 1, change24hPercent: 0 }];
      const t = this.tickers.get(`${symbol}/USDT`);
      return t ? [{ symbol, priceUsd: t.close, change24hPercent: round2(t.chg * 100) }] : [];
    });
  }

  /** Keeps one point per HISTORY_STEP_MS bucket (latest wins) over the last 24h. */
  private recordHistory(value: number): void {
    const t = this.now();
    const last = this.history.at(-1);
    if (last && Math.floor(last.t / HISTORY_STEP_MS) === Math.floor(t / HISTORY_STEP_MS)) {
      last.t = t;
      last.v = value;
    } else {
      this.history.push({ t, v: value });
    }
    const cutoff = t - HISTORY_WINDOW_MS;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
  }

  /**
   * Rapira has no public candles endpoint, so right after startup we only know
   * the 24h open/low/high and the current price. Until enough of our own samples
   * accumulate, prepend those so the sparkline isn't a single dot.
   */
  private historyWithSeed(usdt: RapiraTicker): RatePoint[] {
    if (this.history.length >= 12) return [...this.history];
    const m = (p: number) => applyMarkup(p, this.margins.buyMarkupPercent);
    const now = this.now();
    const day = HISTORY_WINDOW_MS;
    const seed: RatePoint[] = [
      { t: now - day, v: m(usdt.open) },
      { t: now - day * 0.66, v: m(usdt.low) },
      { t: now - day * 0.33, v: m(usdt.high) },
    ];
    return [...seed, ...this.history];
  }
}
