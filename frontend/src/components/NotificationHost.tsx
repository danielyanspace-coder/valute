import { useCallback, useState } from 'react';
import type { NotificationDto } from '../../../shared/api';
import { api } from '../lib/backend';
import { hapticNotify, openTelegramChat } from '../lib/telegram';
import { usePolling } from '../lib/useInterval';
import { shortUsdt } from '../../../shared/transfers';
import { IconAlert, IconPlus } from './icons';
import { Sheet } from './Sheet';
import { CoinDrop, Confetti, SuccessMark } from '../lib/motion';
import { IconGift, LogoX } from './icons';

interface Props {
  supportUsername: string;
  /** Opens a withdrawal; used for "money sent, please confirm" and "rejected". */
  onOpenWithdrawal: (id: number) => void;
  onAnything: () => void;
  onOpenOrder: (id: number) => void;
  onOpenUsdtPayout: (id: number) => void;
}

/** Polls in-app notifications and turns each into the right screen or modal. */
export function NotificationHost({ supportUsername, onOpenWithdrawal, onAnything, onOpenOrder, onOpenUsdtPayout }: Props) {
  const [modal, setModal] = useState<NotificationDto | null>(null);

  const poll = useCallback(async () => {
    if (modal) return;
    const { items } = await api.notifications().catch(() => ({ items: [] as NotificationDto[] }));
    if (!items.length) return;
    await api.markNotificationsSeen(items.map((n) => n.id)).catch(() => {});
    onAnything();
    // Show the most important one; the rest are reflected in balances and history.
    const order = [
      'support_lock', 'deal_reminder', 'order_clarify', 'deal_cancelled', 'deal_corrected', 'obligation_repaid', 'order_rejected',
      'usdt_payout_rejected', 'giveaway_won', 'order_paid', 'usdt_payout_sent', 'deposit_credited', 'premium_cashback', 'transfer_received',
      'check_claimed', 'deal_completed',
    ];
    const top = [...items].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))[0];
    hapticNotify(['deal_completed', 'transfer_received', 'check_claimed', 'deposit_credited', 'usdt_payout_sent', 'giveaway_won', 'premium_cashback'].includes(top.type) ? 'success' : 'warning');
    // support_lock: the blocking screen is driven by /api/me (refreshed above), nothing to show here.
    if (top.type === 'support_lock') return;
    // Service orders: open the order itself, it shows the status, the question or the reason.
    if (top.type.startsWith('order_') && top.order) return onOpenOrder(top.order.id);
    // Deals: the deal screen shows the buttons and the outcome.
    if (top.type.startsWith('deal_') && top.withdrawalId) return onOpenWithdrawal(top.withdrawalId);
    // USDT withdrawals: the request screen shows the hash or the reason.
    if (top.type.startsWith('usdt_payout_') && top.usdtPayout) return onOpenUsdtPayout(top.usdtPayout.id);
    setModal(top);
  }, [modal, onAnything, onOpenWithdrawal, onOpenOrder, onOpenUsdtPayout]);

  usePolling(poll, 5000);

  if (!modal) return null;
  const close = () => setModal(null);

  if (modal.type === 'transfer_received' && modal.transfer) {
    const t = modal.transfer;
    return (
      <Sheet open onClose={close} title="">
        <div className="modal-center">
          <span className="modal-icon ok"><IconPlus size={26} /></span>
          <b>+{shortUsdt(t.amountMicro)} USDT</b>
          <p className="muted">
            {t.kind === 'check' ? 'Чек от' : 'Перевод от'} {t.counterparty.username ? `@${t.counterparty.username}` : t.counterparty.firstName}
            {t.comment ? `: «${t.comment}»` : ''}. Средства уже на балансе.
          </p>
          <div className="sheet-actions"><button className="btn primary" onClick={close}>Отлично</button></div>
        </div>
      </Sheet>
    );
  }

  if (modal.type === 'deposit_credited' && modal.deposit) {
    return (
      <Sheet open onClose={close} title="">
        <div className="modal-center">
          <CoinDrop />
          <b>+{shortUsdt(modal.deposit.amountMicro)} USDT</b>
          <p className="muted">Пополнение через TRON (TRC-20) зачислено на баланс.</p>
          <div className="sheet-actions"><button className="btn primary" onClick={close}>Отлично</button></div>
        </div>
      </Sheet>
    );
  }

  if (modal.type === 'obligation_repaid' && modal.deduction) {
    const d = modal.deduction;
    return (
      <Sheet open onClose={close} title="">
        <div className="modal-center">
          <span className="modal-icon warn"><IconAlert size={26} /></span>
          <b>Удержано {shortUsdt(d.amountMicro)} USDT</b>
          <p className="muted">Причина: {d.reason}. Если вы не согласны с удержанием, свяжитесь с поддержкой.</p>
          <div className="sheet-actions">
            <button className="btn ghost" onClick={close}>Закрыть</button>
            {supportUsername && <button className="btn primary" onClick={() => { openTelegramChat(supportUsername); close(); }}>Поддержка</button>}
          </div>
        </div>
      </Sheet>
    );
  }

  if (modal.type === 'check_claimed' && modal.check) {
    const c = modal.check;
    const by = c.claimedBy ? (c.claimedBy.username ? `@${c.claimedBy.username}` : c.claimedBy.firstName) : 'получатель';
    return (
      <Sheet open onClose={close} title="">
        <div className="modal-center">
          <SuccessMark />
          <b>Чек активирован</b>
          <p className="muted">{by} получил {shortUsdt(c.amountMicro)} USDT по вашему чеку.</p>
          <div className="sheet-actions"><button className="btn primary" onClick={close}>Хорошо</button></div>
        </div>
      </Sheet>
    );
  }

  if (modal.type === 'giveaway_won') {
    return (
      <Sheet open onClose={close} title="">
        <Confetti fire={modal.id} />
        <div className="modal-center">
          <span className="modal-icon gift"><IconGift size={26} /></span>
          <b>Вы выиграли +{shortUsdt(modal.amountMicro ?? 0)} USDT</b>
          <p className="muted">Поздравляем! Приз розыгрыша уже на балансе.</p>
          <div className="sheet-actions"><button className="btn primary" onClick={close}>Отлично</button></div>
        </div>
      </Sheet>
    );
  }

  if (modal.type === 'premium_cashback') {
    return (
      <Sheet open onClose={close} title="">
        <div className="modal-center">
          <span className="modal-icon black"><LogoX size={26} /></span>
          <b>Кэшбэк +{shortUsdt(modal.amountMicro ?? 0)} USDT</b>
          <p className="muted">0.2% от оборота за прошлый месяц по статусу IX Black зачислены на баланс.</p>
          <div className="sheet-actions"><button className="btn primary" onClick={close}>Отлично</button></div>
        </div>
      </Sheet>
    );
  }

  return null;
}
