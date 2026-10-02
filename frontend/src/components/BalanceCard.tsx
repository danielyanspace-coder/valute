import { fmtPct, fmtUsd } from '../lib/format';
import { IconEye, IconEyeOff, LogoX } from './icons';

interface Props {
  balanceUsd: number;
  change24hUsd: number;
  change24hPct: number;
  hidden: boolean;
  onToggleHidden: () => void;
}

export function BalanceCard({ balanceUsd, change24hUsd, change24hPct, hidden, onToggleHidden }: Props) {
  const up = change24hUsd >= 0;
  return (
    <section className="card balance-card">
      <div className="balance-glow" />
      <div className="balance-plastic" aria-hidden>
        <div className="plastic-logo"><LogoX size={26} /><span>Crypto IX</span></div>
        <div className="plastic-chip" />
      </div>
      <div className="brand"><LogoX size={24} /><span>Crypto <b>IX</b></span></div>
      <button className="balance-label" onClick={onToggleHidden}>
        Общий баланс {hidden ? <IconEyeOff size={15} /> : <IconEye size={15} />}
      </button>
      <div className="balance-amount">{hidden ? '$ ••••••' : fmtUsd(balanceUsd)}</div>
      <div className={`balance-change ${up ? 'up' : 'down'}`}>
        <span className="tri">{up ? '▲' : '▼'}</span>
        {hidden ? '••••' : `${up ? '+' : '−'} ${fmtUsd(Math.abs(change24hUsd))} (${fmtPct(change24hPct).replace(/^[+-]/, '')})`}
        <span className="muted">за 24ч</span>
      </div>
      <div className="balance-foot">
        <span>Больше, чем просто кошелек</span>
        <span className="tags">Secure <i>•</i> Fast <i>•</i> Global</span>
      </div>
    </section>
  );
}
