import type { MarketCoin } from '../lib/api';
import { fmtPct, fmtUsd } from '../lib/format';
import { CoinIcon } from './CoinIcon';
import { IconChevronRight } from './icons';
import { Sparkline, trendShape } from './Sparkline';

const NAMES: Record<string, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', USDT: 'Tether', SOL: 'Solana' };

export function CryptoList({ coins, onAll, onCoin }: { coins: MarketCoin[]; onAll: () => void; onCoin: (s: string) => void }) {
  return (
    <section className="card list-card">
      <div className="list-head">
        <h2>Криптовалюты</h2>
        <button className="link" onClick={onAll}>Все <IconChevronRight size={14} /></button>
      </div>
      {coins.length === 0 && [0, 1, 2, 3].map((i) => <div key={i} className="coin-row skeleton-row" />)}
      {coins.map((c) => {
        const up = c.change24hPercent >= 0;
        return (
          <button key={c.symbol} className="coin-row" onClick={() => onCoin(c.symbol)}>
            <CoinIcon symbol={c.symbol} size={32} />
            <div className="coin-name">
              <span>{NAMES[c.symbol] ?? c.symbol}</span>
              <span className="muted">{c.symbol}</span>
            </div>
            <div className="coin-price">{fmtUsd(c.priceUsd)}</div>
            <div className={`coin-change ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {fmtPct(c.change24hPercent)}</div>
            <div className="coin-spark">
              <Sparkline values={trendShape(c.symbol, c.change24hPercent)} width={50} height={22} color={up ? 'var(--green)' : 'var(--red)'} />
            </div>
          </button>
        );
      })}
    </section>
  );
}
