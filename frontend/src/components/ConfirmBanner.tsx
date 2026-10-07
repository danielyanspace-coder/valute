import { useEffect, useState } from 'react';
import type { WithdrawalDto } from '../../../shared/api';
import { INACTIVE_AFTER_MS } from '../../../shared/deals';
import { fmtCountdown, fmtRub0 } from '../lib/format';
import { IconChevronRight, IconClock } from './icons';

/** Home-screen reminder while a deal waits for the user's answer. */
export function ConfirmBanner({ w, onOpen }: { w: WithdrawalDto; onOpen: () => void }) {
  const [, tick] = useState(0);
  const [skew] = useState(() => w.serverNow - Date.now());
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = w.status === 'entered' && w.enteredAt ? w.enteredAt + INACTIVE_AFTER_MS - (Date.now() + skew) : null;
  return (
    <button className="card confirm-banner" onClick={onOpen}>
      <span className="confirm-banner-icon"><IconClock size={18} /></span>
      <span className="confirm-banner-text">
        <b>{w.status === 'not_received' ? `Проверяем платёж ${fmtRub0(w.amountRub)}` : `Подтвердите получение ${fmtRub0(w.amountRub)}`}</b>
        <span>
          {w.status === 'not_received'
            ? `Заявка №${w.id} · с вами свяжется поддержка`
            : left !== null && left > 0
              ? `Заявка №${w.id} · осталось ${fmtCountdown(left)}`
              : `Заявка №${w.id} · нужен ваш ответ`}
        </span>
      </span>
      <IconChevronRight size={16} />
    </button>
  );
}
