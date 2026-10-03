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
        {hidden ? (
          <span className="bal-int">$ ••••••</span>
        ) : (
          <BalanceDigits value={balanceUsd ?? 0} />
        )}
      </div>
      {frozenUsd > 0 && (
        <div className="balance-frozen">
          <IconSnow size={13} /> {hidden ? '••••' : fmtUsd(frozenUsd)} заморожено в заявках и чеках
        </div>
      )}
      <div className="balance-foot">
        <span>Больше, чем просто кошелек</span>
        <span className="tags">Secure <i>•</i> Fast <i>•</i> Global</span>
      </div>
    </section>
  );
}

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Big dollars, smaller cents: the balance is the anchor of the screen. */
function BalanceDigits({ value }: { value: number }) {
  const cents = Math.round(value * 100);
  const int = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, '0');
  return (
    <>
      <span className="bal-cur">$</span>
      <span className="bal-int">{whole.format(int)}</span>
      <span className="bal-frac">.{frac}</span>
    </>
  );
}
