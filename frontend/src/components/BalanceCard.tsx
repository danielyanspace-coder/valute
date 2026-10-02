import { fmtUsd } from '../lib/format';
import { IconEye, IconEyeOff, IconSnow, LogoX } from './icons';

interface Props {
  balanceUsd: number | null;
  frozenUsd: number;
  hidden: boolean;
  onToggleHidden: () => void;
}

export function BalanceCard({ balanceUsd, frozenUsd, hidden, onToggleHidden }: Props) {
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
      <div className={`balance-amount ${balanceUsd === null ? 'skeleton' : ''}`}>
        {hidden ? '$ ••••••' : fmtUsd(balanceUsd ?? 0)}
      </div>
      {frozenUsd > 0 && (
        <div className="balance-frozen">
          <IconSnow size={13} /> {hidden ? '••••' : fmtUsd(frozenUsd)} заморожено в выводах и чеках
        </div>
      )}
      <div className="balance-foot">
        <span>Больше, чем просто кошелек</span>
        <span className="tags">Secure <i>•</i> Fast <i>•</i> Global</span>
      </div>
    </section>
  );
}
