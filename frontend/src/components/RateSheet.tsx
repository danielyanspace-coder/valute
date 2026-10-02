import { useState } from 'react';
import type { WalletRate } from '../lib/api';
import { fmtPct } from '../lib/format';
import { Sheet } from './Sheet';
import { Sparkline } from './Sparkline';

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function RateSheet({ rate, open, onClose }: { rate: WalletRate | null; open: boolean; onClose: () => void }) {
  const [usdt, setUsdt] = useState('100');
  if (!rate) return null;
  const amount = Number(usdt.replace(',', '.')) || 0;
  const up = rate.change24hPercent >= 0;
  return (
    <Sheet open={open} onClose={onClose} title="Курс USDT">
      <div className="rate-sheet-head">
        <span className="rate-big">{rub.format(rate.walletRate)} ₽</span>
        <span className={`rate-change ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {fmtPct(rate.change24hPercent)} за 24ч</span>
      </div>
      <Sparkline values={rate.history.map((p) => p.v)} height={120} color={up ? 'var(--green)' : 'var(--red)'} />
      <div className="converter">
        <label>
          <span className="muted">Количество</span>
          <div className="conv-input">
            <input inputMode="decimal" value={usdt} onChange={(e) => setUsdt(e.target.value.replace(/[^\d.,]/g, ''))} />
            <b>USDT</b>
          </div>
        </label>
        <div className="conv-eq">=</div>
        <div className="conv-out">
          <span className="muted">Стоимость</span>
          <b>{rub.format(amount * rate.walletRate)} ₽</b>
        </div>
      </div>
      <p className="muted small">
        1 ₽ = {(1 / rate.walletRate).toFixed(4)} USDT · обновлено {new Date(rate.updatedAt).toLocaleTimeString('ru-RU')}
      </p>
    </Sheet>
  );
}
