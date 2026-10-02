import { useEffect, useState } from 'react';
import type { WithdrawalDto } from '../../../../shared/api';
import { STATUS_LABEL } from '../../../../shared/payout';
import { api } from '../../lib/backend';
import { fmtCountdown, fmtDateTime, fmtMicro, fmtRub, fmtRub0 } from '../../lib/format';
import { haptic, hapticNotify, openTelegramChat } from '../../lib/telegram';
import { IconAlert, IconCheck, IconClock, IconClose } from '../icons';
import { Sheet } from '../Sheet';
import { Notice } from './WithdrawFlow';

interface Props {
  id: number | null;
  onClose: () => void;
  onChanged: () => void;
  supportUsername: string;
  usernameHidden: boolean;
}

/** One withdrawal: status, countdown and the "money arrived / did not arrive" buttons. */
export function WithdrawalSheet({ id, onClose, onChanged, supportUsername, usernameHidden }: Props) {
  const [w, setW] = useState<WithdrawalDto | null>(null);
  const [skew, setSkew] = useState(0);
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askDispute, setAskDispute] = useState(false);

  useEffect(() => {
    if (id === null) return;
    setW(null);
    setError(null);
    setAskDispute(false);
    let alive = true;
    const load = () =>
      api.withdrawal(id).then((x) => {
        if (!alive) return;
        setW(x);
        setSkew(x.serverNow - Date.now());
      }, (e) => alive && setError((e as Error).message));
    load();
    const poll = setInterval(load, 5000);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(t);
    };
  }, [id]);

  const act = async (fn: () => Promise<WithdrawalDto>) => {
    setBusy(true);
    setError(null);
    try {
      const x = await fn();
      setW(x);
      hapticNotify('success');
      onChanged();
    } catch (e) {
      hapticNotify('error');
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setAskDispute(false);
    }
  };

  const left = w?.confirmDeadline ? w.confirmDeadline - (Date.now() + skew) : 0;

  return (
    <Sheet open={id !== null} onClose={onClose} title={w ? `Вывод #${w.id}` : 'Вывод'}>
      {!w && !error && <div className="skeleton" style={{ height: 160 }} />}
      {w && (
        <div className="wd">
          <div className={`wd-status s-${w.status}`}>
            <span className="wd-status-icon">
              {w.status === 'completed' ? <IconCheck size={18} /> : w.status === 'rejected' ? <IconClose size={16} /> : w.status === 'disputed' ? <IconAlert size={16} /> : <IconClock size={18} />}
            </span>
            {STATUS_LABEL[w.status]}
          </div>
          <div className="wd-amount">{fmtRub0(w.amountRub)}</div>
          <div className="muted wd-dest">{w.destination}</div>

          {w.status === 'pending' && (
            <Notice tone="info">Заявка в работе. Мы пришлём уведомление, когда отправим деньги.</Notice>
          )}

          {w.status === 'sent' && (
            <div className="confirm-box">
              <b>Деньги отправлены</b>
              <p>Проверьте поступление и подтвердите получение.</p>
              <div className="countdown">
                <IconClock size={15} /> Автоподтверждение через {fmtCountdown(left)}
              </div>
              {!askDispute ? (
                <div className="sheet-actions">
                  <button className="btn ghost" disabled={busy} onClick={() => { haptic(); setAskDispute(true); }}>
                    Деньги не пришли
                  </button>
                  <button className="btn success" disabled={busy} onClick={() => act(() => api.confirmWithdrawal(w.id))}>
                    Деньги пришли
                  </button>
                </div>
              ) : (
                <div className="ask">
                  <p>Точно не пришли? Проверьте историю операций в банке. Мы остановим автоподтверждение и подключим поддержку.</p>
                  <div className="sheet-actions">
                    <button className="btn ghost" disabled={busy} onClick={() => setAskDispute(false)}>Назад</button>
                    <button className="btn danger" disabled={busy} onClick={() => act(() => api.disputeWithdrawal(w.id))}>
                      Да, не пришли
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {w.status === 'disputed' && (
            <div className="dispute-box">
              <b>Проверяем платёж</b>
              <p>
                Автоподтверждение остановлено. Сотрудник поддержки свяжется с вами в Telegram и поможет разобраться.
              </p>
              {usernameHidden && (
                <Notice tone="warn">
                  У вас скрыт username в Telegram, поэтому мы не сможем написать первыми. Напишите в поддержку сами.
                </Notice>
              )}
              {supportUsername && (
                <button className="btn ghost block" onClick={() => openTelegramChat(supportUsername)}>Написать в поддержку</button>
              )}
            </div>
          )}

          {w.status === 'rejected' && (
            <Notice tone="danger">
              Заявка отклонена{w.rejectReason ? `: ${w.rejectReason}` : ''}. {fmtMicro(w.amountMicro)} вернулись на баланс.
            </Notice>
          )}

          {error && <Notice tone="danger">{error}</Notice>}

          <div className="kv-list">
            <Kv k="Способ" v={w.method === 'sbp' ? 'СБП' : 'На карту'} />
            <Kv k="Списание" v={fmtMicro(w.amountMicro)} />
            <Kv k="Курс" v={`1 USDT = ${fmtRub(w.rate)}`} />
            <Kv k="Создана" v={fmtDateTime(w.createdAt)} />
            {w.sentAt && <Kv k="Отправлена" v={fmtDateTime(w.sentAt)} />}
            {w.finishedAt && (
              <Kv
                k={w.status === 'rejected' ? 'Отклонена' : 'Завершена'}
                v={`${fmtDateTime(w.finishedAt)}${w.confirmedBy === 'auto' ? ', автоматически' : w.confirmedBy === 'admin' ? ', поддержкой' : ''}`}
              />
            )}
          </div>
        </div>
      )}
      {!w && error && <Notice tone="danger">{error}</Notice>}
    </Sheet>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}
