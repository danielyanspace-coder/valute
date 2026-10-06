import { openTelegramChat } from '../lib/telegram';
import { IconChat } from './icons';

/**
 * Blocking screen while the operator requires the user to contact support.
 * No close button on purpose: it disappears when the operator lifts the lock.
 */
export function ContactLock({ supportUsername }: { supportUsername: string }) {
  return (
    <div className="lock-screen" role="alertdialog" aria-modal="true" aria-labelledby="lock-title">
      <div className="lock-card">
        <span className="modal-icon warn"><IconChat size={28} /></span>
        <b id="lock-title">Свяжитесь с поддержкой</b>
        <p>Нам нужно уточнить детали. Операции в кошельке приостановлены до связи с поддержкой.</p>
        {supportUsername ? (
          <button className="btn primary block" onClick={() => openTelegramChat(supportUsername)}>Написать в поддержку</button>
        ) : (
          <p className="lock-note">Напишите в поддержку через меню бота.</p>
        )}
      </div>
    </div>
  );
}
