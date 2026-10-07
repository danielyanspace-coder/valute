import { useEffect, useState } from 'react';
import type { UsdtPayoutDto } from '../../../../shared/api';
import { shortUsdt } from '../../../../shared/transfers';
import { USDT_PAYOUT_STATUS_LABEL } from '../../../../shared/usdtPayout';
import { api } from '../../lib/backend';
import { fmtDateTime } from '../../lib/format';
import { copyText, hapticNotify, openTelegramChat, tg } from '../../lib/telegram';
import { IconCheck, IconClock, IconClose, IconCopy } from '../icons';
import { Sheet } from '../Sheet';
import { Notice } from './WithdrawFlow';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-6)}`;

function openTx(txId: string) {
  const url = `https://tronscan.org/#/transaction/${txId}`;
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** A USDT TRC-20 withdrawal as the user sees it. */
export function UsdtPayoutSheet({ id, onClose, supportUsername }: { id: number | null; onClose: () => void; supportUsername: string }) {
  const [p, setP] = useState<UsdtPayoutDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (id === null) return;
    setP(null);
    setError(null);
    let alive = true;
    const load = () => api.usdtPayout(id).then((x) => alive && setP(x), (e) => alive && setError((e as Error).message));
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  const copyAddress = async () => {
    if (p && (await copyText(p.address))) {
      hapticNotify('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const tone = p?.status === 'sent' ? 'completed' : p?.status === 'rejected' ? 'rejected' : 'pending';
  return (
    <Sheet open={id !== null} onClose={onClose} title={p ? `Вывод USDT №${p.id}` : 'Вывод USDT'}>
      {!p && !error && <div className="skeleton" style={{ height: 160 }} />}
      {!p && error && <Notice tone="danger">{error}</Notice>}
      {p && (
        <div className="wd">
          <div className={`wd-status s-${tone}`}>
            <span className="wd-status-icon">
              {p.status === 'sent' ? <IconCheck size={18} /> : p.status === 'rejected' ? <IconClose size={16} /> : <IconClock size={18} />}
            </span>
            {USDT_PAYOUT_STATUS_LABEL[p.status]}
          </div>
          <div className="wd-amount">{shortUsdt(p.amountMicro)} USDT</div>
          <div className="muted wd-dest">TRON (TRC-20) · {short(p.address)}</div>

          {p.status === 'new' && <Notice tone="info">Заявка в обработке. Отправляем вручную, обычно в течение часа. Пришлём уведомление с хэшем транзакции.</Notice>}
          {p.status === 'sent' && p.txId && (
            <>
              <Notice tone="info">USDT отправлены. Если они ещё не видны в кошельке, подождите пару минут: сети нужно подтвердить перевод.</Notice>
              <button className="btn ghost block" onClick={() => openTx(p.txId!)}>Открыть транзакцию в Tronscan</button>
            </>
          )}
          {p.status === 'rejected' && (
            <>
              <Notice tone="danger">Заявка отклонена: {p.rejectReason}. {shortUsdt(p.totalMicro)} USDT вернулись на баланс.</Notice>
              {supportUsername && <button className="btn ghost block" onClick={() => openTelegramChat(supportUsername)}>Написать в поддержку</button>}
            </>
          )}

          <div className="kv-list">
            <div className="kv">
              <span className="muted">Адрес</span>
              <button className="link-btn mono" onClick={copyAddress}>{copied ? 'Скопировано' : short(p.address)} <IconCopy size={13} /></button>
            </div>
            <div className="kv"><span className="muted">Получатель получит</span><span>{shortUsdt(p.amountMicro)} USDT</span></div>
            <div className="kv"><span className="muted">Комиссия сети</span><span>{shortUsdt(p.feeMicro)} USDT</span></div>
            <div className="kv"><span className="muted">{p.status === 'new' ? 'Заморожено' : p.status === 'sent' ? 'Списано' : 'Возвращено'}</span><span>{shortUsdt(p.totalMicro)} USDT</span></div>
            {p.txId && (
              <div className="kv"><span className="muted">Транзакция</span><button className="link-btn mono" onClick={() => openTx(p.txId!)}>{short(p.txId)}</button></div>
            )}
            <div className="kv"><span className="muted">Создана</span><span>{fmtDateTime(p.createdAt)}</span></div>
            {p.finishedAt && <div className="kv"><span className="muted">{p.status === 'sent' ? 'Отправлена' : 'Отклонена'}</span><span>{fmtDateTime(p.finishedAt)}</span></div>}
          </div>
        </div>
      )}
    </Sheet>
  );
}
