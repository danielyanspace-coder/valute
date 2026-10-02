import { useCallback, useState } from 'react';
import type { NotificationDto } from '../../../shared/api';
import { api } from '../lib/backend';
import { hapticNotify, openTelegramChat } from '../lib/telegram';
import { usePolling } from '../lib/useInterval';
import { IconChat, IconCheck } from './icons';
import { Sheet } from './Sheet';

interface Props {
  supportUsername: string;
  /** Opens a withdrawal; used for "money sent, please confirm" and "rejected". */
  onOpenWithdrawal: (id: number) => void;
  onAnything: () => void;
}

/** Polls in-app notifications and turns each into the right screen or modal. */
export function NotificationHost({ supportUsername, onOpenWithdrawal, onAnything }: Props) {
  const [modal, setModal] = useState<NotificationDto | null>(null);

  const poll = useCallback(async () => {
    if (modal) return;
    const { items } = await api.notifications().catch(() => ({ items: [] as NotificationDto[] }));
    if (!items.length) return;
    await api.markNotificationsSeen(items.map((n) => n.id)).catch(() => {});
    onAnything();
    // Show the most important one; the rest are reflected in balances and history.
    const order = ['contact_support', 'confirm_receipt', 'withdrawal_rejected', 'withdrawal_completed'];
    const top = [...items].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))[0];
    hapticNotify(top.type === 'withdrawal_completed' ? 'success' : 'warning');
    if ((top.type === 'confirm_receipt' || top.type === 'withdrawal_rejected') && top.withdrawalId) {
      onOpenWithdrawal(top.withdrawalId);
    } else {
      setModal(top);
    }
  }, [modal, onAnything, onOpenWithdrawal]);

  usePolling(poll, 5000);

  if (!modal) return null;
  const close = () => setModal(null);

  if (modal.type === 'contact_support') {
    return (
      <Sheet open onClose={close} title="">
        <div className="modal-center">
          <span className="modal-icon warn"><IconChat size={26} /></span>
          <b>Свяжитесь с поддержкой</b>
          <p className="muted">
            Нам нужно уточнить детали по вашей заявке{modal.withdrawalId ? ` #${modal.withdrawalId}` : ''}. Ваш username в
            Telegram скрыт, поэтому мы не можем написать первыми.
          </p>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={close}>Позже</button>
            {supportUsername && (
              <button className="btn primary" onClick={() => { openTelegramChat(supportUsername); close(); }}>
                Написать в поддержку
              </button>
            )}
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={close} title="">
      <div className="modal-center">
        <span className="modal-icon ok"><IconCheck size={26} /></span>
        <b>Вывод выполнен</b>
        <p className="muted">Заявка{modal.withdrawalId ? ` #${modal.withdrawalId}` : ''} завершена, детали в истории.</p>
        <div className="sheet-actions">
          <button className="btn ghost" onClick={close}>Закрыть</button>
          {modal.withdrawalId && (
            <button className="btn primary" onClick={() => { onOpenWithdrawal(modal.withdrawalId!); close(); }}>Открыть</button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
