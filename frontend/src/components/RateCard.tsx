import type { WalletRate } from '../lib/api';
import { fmtPct } from '../lib/format';
import { CoinIcon } from './CoinIcon';
import { IconChevronRight } from './icons';
import { Sparkline } from './Sparkline';

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function RateCard({ rate, error, onOpen }: { rate: WalletRate | null; error: boolean; onOpen: () => void }) {
  const up = (rate?.change24hPercent ?? 0) >= 0;
  return (
    <button className="card rate-card" onClick={onOpen}>
      <div className="rate-top">
        <CoinIcon symbol="USDT" size={38} />
        <div className="rate-title">
          <span className="muted">Актуальный курс кошелька</span>
          <span className="rate-title-row">
            <b>USDT</b>
            <span className="rate-pill">На вывод</span>
          </span>
        </div>
        <IconChevronRight className="rate-chevron" size={16} />
      </div>
      <div className="rate-bottom">
        <div className="rate-value">
          {rate ? (
            <>
              <span className="rate-big">{rub.format(rate.walletRate)} ₽</span>
              <span className={`rate-change ${up ? 'up' : 'down'}`}>
                <span>{up ? '▲' : '▼'} {fmtPct(rate.change24hPercent)}</span>
                <span className="muted">за 24ч</span>
              </span>
            </>
          ) : (
            <span className={`rate-big ${error ? '' : 'skeleton'}`}>{error ? 'Нет данных' : '00,00 ₽'}</span>
          )}
        </div>
        <div className="rate-chart">
          {rate && <Sparkline values={rate.history.map((p) => p.v)} height={46} dots color={up ? 'var(--green)' : 'var(--red)'} />}
        </div>
      </div>
    </button>
  );
}
