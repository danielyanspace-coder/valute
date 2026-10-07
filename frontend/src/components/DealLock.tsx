import { fmtRub0 } from '../lib/format';
import { IconClock } from './icons';

/**
 * Blocking screen after the time to answer on a deal ran out. The only way out is
 * to answer (or the operator closes the deal), so there is no close button.
 */
export function DealLock({ lock, onAnswer }: { lock: { withdrawalId: number; amountRub: number }; onAnswer: () => void }) {
  return (
    <div className="lock-screen" role="alertdialog" aria-modal="true" aria-labelledby="deal-lock-title">
      <div className="lock-card">
        <span className="modal-icon warn"><IconClock size={28} /></span>
        <b id="deal-lock-title">Время на подтверждение вышло</b>
        <p>
          Поступила ли оплата {fmtRub0(lock.amountRub)} по заявке №{lock.withdrawalId}? Кошелёк приостановлен, пока вы не ответите.
        </p>
        <button className="btn primary block" onClick={onAnswer}>Ответить по заявке</button>
      </div>
    </div>
  );
}
