import { fmtRub0 } from '../lib/format';
import { openTelegramChat } from '../lib/telegram';
import { IconChat } from './icons';

/**
 * Blocking screen shown while the operator waits for the user to get in touch.
 * No close button on purpose: it disappears only when the deal is completed or rejected.
 */
export function ContactLock({ lock, supportUsername }: { lock: { withdrawalId: number; amountRub: number }; supportUsername: string }) {
  return (
    <div className="lock-screen" role="alertdialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-card">
        <span className="modal-icon warn"><IconChat size={28} /></span>
        <b id="lock-title">Свяжитесь с поддержкой</b>
        <p>
          По заявке #{lock.withdrawalId} на {fmtRub0(lock.amountRub)} нам нужно уточнить детали. Ваш username в Telegram
          скрыт, поэтому мы не можем написать первыми.
        </p>
        <p className="lock-note">Кошелёк будет доступен, когда поддержка завершит заявку.</p>
        {supportUsername ? (
          <button className="btn primary block" onClick={() => openTelegramChat(supportUsername)}>Написать в поддержку</button>
        ) : (
          <p className="lock-note">Напишите в поддержку через меню бота.</p>
        )}
      </div>
    </div>
  );
}
