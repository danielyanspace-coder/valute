import type { DepositDto, DepositStatus } from '../../../../shared/api';
import { shortUsdt } from '../../../../shared/transfers';
import { fmtDateTime } from '../../lib/format';
import { openTelegramChat, tg } from '../../lib/telegram';
import { IconAlert, IconCheck, IconClock, IconClose } from '../icons';
import { Sheet } from '../Sheet';
import { Notice } from '../withdraw/WithdrawFlow';

export const DEPOSIT_STATUS_LABEL: Record<DepositStatus, string> = {
  pending: 'Подтверждается',
  credited: 'Зачислено',
  below_min: 'Меньше минимума',
  held: 'На проверке',
  rejected: 'Не зачислено',
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;

function openTx(txId: string) {
  const url = `https://tronscan.org/#/transaction/${txId}`;
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

interface Props {
  deposit: DepositDto | null;
  onClose: () => void;
  supportUsername: string;
}

export function DepositDetailSheet({ deposit: d, onClose, supportUsername }: Props) {
  const support = supportUsername ? (
    <button className="btn ghost block" onClick={() => openTelegramChat(supportUsername)}>Написать в поддержку</button>
  ) : null;
  return (
    <Sheet open={!!d} onClose={onClose} title="Пополнение">
      {d && (
        <div className="wd">
          <div className={`wd-status dep-${d.status}`}>
            <span className="wd-status-icon">
              {d.status === 'credited' ? <IconCheck size={18} /> : d.status === 'rejected' ? <IconClose size={16} /> : d.status === 'pending' ? <IconClock size={18} /> : <IconAlert size={16} />}
            </span>
            {DEPOSIT_STATUS_LABEL[d.status]}
          </div>
          <div className={`wd-amount ${d.status === 'credited' ? 'up' : ''}`}>+{shortUsdt(d.amountMicro)} USDT</div>
          <div className="muted wd-dest">TRON (TRC-20)</div>

          {d.status === 'pending' && (
            <Notice tone="info">Перевод найден в сети TRON. Зачислим после подтверждения блокчейна, обычно это 1-2 минуты.</Notice>
          )}
          {d.status === 'below_min' && (
            <>
              <Notice tone="warn">Сумма меньше минимальной, поэтому не зачислена автоматически. Напишите в поддержку, поможем.</Notice>
              {support}
            </>
          )}
          {d.status === 'held' && (
            <>
              <Notice tone="info">Перевод проходит дополнительную проверку. Обычно это занимает до нескольких часов, мы пришлём уведомление.</Notice>
              {support}
            </>
          )}
          {d.status === 'rejected' && (
            <>
              <Notice tone="danger">Пополнение не может быть зачислено. Подробности расскажем в поддержке.</Notice>
              {support}
            </>
          )}

          <div className="kv-list">
            {d.fromAddress && (
              <div className="kv"><span className="muted">Отправитель</span><span className="mono">{short(d.fromAddress)}</span></div>
            )}
            <div className="kv"><span className="muted">Отправлено</span><span>{fmtDateTime(d.createdAt)}</span></div>
            {d.creditedAt && <div className="kv"><span className="muted">Зачислено</span><span>{fmtDateTime(d.creditedAt)}</span></div>}
            <div className="kv">
              <span className="muted">Транзакция</span>
              <button className="link-btn mono" onClick={() => openTx(d.txId)}>{short(d.txId)}</button>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
