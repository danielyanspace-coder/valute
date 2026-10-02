import { useEffect, useState } from 'react';
import type { WithdrawalDto } from '../../../shared/api';
import { fmtCountdown, fmtRub0 } from '../lib/format';
import { IconChevronRight, IconClock } from './icons';

/** Home-screen reminder while a payout waits for the user's confirmation. */
export function ConfirmBanner({ w, onOpen }: { w: WithdrawalDto; onOpen: () => void }) {
  const [, tick] = useState(0);
  const [skew] = useState(() => w.serverNow - Date.now());
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = (w.confirmDeadline ?? 0) - (Date.now() + skew);
  return (
    <button className="card confirm-banner" onClick={onOpen}>
      <span className="confirm-banner-icon"><IconClock size={18} /></span>
      <span className="confirm-banner-text">
        <b>Подтвердите получение {fmtRub0(w.amountRub)}</b>
        <span>Автоподтверждение через {fmtCountdown(left)}</span>
      </span>
      <IconChevronRight size={16} />
    </button>
  );
}
