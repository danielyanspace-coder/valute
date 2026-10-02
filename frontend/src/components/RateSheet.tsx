import type { WalletRate } from '../lib/api';
import { fmtPct } from '../lib/format';
import { Sheet } from './Sheet';
import { Sparkline } from './Sparkline';

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function RateSheet({ rate, open, onClose }: { rate: WalletRate | null; open: boolean; onClose: () => void }) {
  if (!rate) return null;
  const up = rate.change24hPercent >= 0;
  return (
    <Sheet open={open} onClose={onClose} title="Курс USDT">
      <div className="rate-sheet-head">
        <span className="rate-big">{rub.format(rate.walletRate)} ₽</span>
        <span className={`rate-change ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {fmtPct(rate.change24hPercent)} за 24ч</span>
      </div>
      <Sparkline values={rate.history.map((p) => p.v)} height={120} color={up ? 'var(--green)' : 'var(--red)'} />
      <div className="rate-tile single">
        <span className="muted">Продажа USDT</span>
        <b>1 USDT = {rub.format(rate.walletRate)} ₽</b>
        <span className="muted small">По этому курсу считается вывод в рубли</span>
      </div>
      <p className="muted small">Обновлено {new Date(rate.updatedAt).toLocaleTimeString('ru-RU')}</p>
    </Sheet>
  );
}
