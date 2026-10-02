import { useState } from 'react';
import type { WalletRate } from '../lib/api';
import { fmtPct, fmtUsdt } from '../lib/format';
import { Sheet } from './Sheet';
import { Sparkline } from './Sparkline';

const rub = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function RateSheet({ rate, open, onClose }: { rate: WalletRate | null; open: boolean; onClose: () => void }) {
  const [rubInput, setRubInput] = useState('1000');
  if (!rate) return null;
  const amountRub = Number(rubInput.replace(',', '.')) || 0;
  const up = rate.change24hPercent >= 0;
  return (
    <Sheet open={open} onClose={onClose} title="Курс USDT">
      <div className="rate-sheet-head">
        <span className="rate-big">{rub.format(rate.buyRate)} ₽</span>
        <span className={`rate-change ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {fmtPct(rate.change24hPercent)} за 24ч</span>
      </div>
      <Sparkline values={rate.history.map((p) => p.v)} height={110} color={up ? 'var(--green)' : 'var(--red)'} />
      <div className="rate-tiles">
        <div className="rate-tile">
          <span className="muted">Покупка USDT</span>
          <b>{rub.format(rate.buyRate)} ₽</b>
        </div>
        <div className="rate-tile">
          <span className="muted">Оплата по СБП</span>
          <b>{rub.format(rate.sellRate)} ₽</b>
        </div>
      </div>
      <div className="converter">
        <label>
          <span className="muted">Сумма оплаты по СБП</span>
          <div className="conv-input">
            <input inputMode="decimal" value={rubInput} onChange={(e) => setRubInput(e.target.value.replace(/[^\d.,]/g, ''))} />
            <b>₽</b>
          </div>
        </label>
        <div className="conv-out">
          <span className="muted">Спишется с баланса</span>
          <b>{fmtUsdt(amountRub / rate.sellRate)}</b>
        </div>
      </div>
      <p className="muted small">Обновлено {new Date(rate.updatedAt).toLocaleTimeString('ru-RU')}</p>
    </Sheet>
  );
}
