import { useEffect, useState } from 'react';
import type { WithdrawalDto } from '../../../../shared/api';
import { INACTIVE_AFTER_MS, userStatusLabel } from '../../../../shared/deals';
import { api } from '../../lib/backend';
import { fmtCountdown, fmtDateTime, fmtMicro, fmtRub, fmtRub0 } from '../../lib/format';
import { haptic, hapticNotify, openTelegramChat } from '../../lib/telegram';
import { IconAlert, IconCheck, IconClock, IconClose } from '../icons';
import { Sheet } from '../Sheet';
import { Notice } from './WithdrawFlow';

type Mode = 'idle' | 'confirm' | 'other' | 'not';

interface Props {
  id: number | null;
  onClose: () => void;
  onChanged: () => void;
  supportUsername: string;
  /** Opened from the bot's "other amount" button: go straight to the amount field. */
  startWithOtherAmount?: boolean;
}

const tone = (s: WithdrawalDto['status']) =>
  s === 'completed' || s === 'user_confirmed' ? 'completed' : s === 'cancelled' ? 'rejected' : s === 'not_received' || s === 'mismatch' || s === 'inactive' ? 'disputed' : 'pending';

/** One deal: its state and the user's answers ("received", "other amount", "not received"). */
export function WithdrawalSheet({ id, onClose, onChanged, supportUsername, startWithOtherAmount }: Props) {
  const [w, setW] = useState<WithdrawalDto | null>(null);
  const [skew, setSkew] = useState(0);
  const [, tick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [other, setOther] = useState('');

  useEffect(() => {
    if (id === null) return;
    setW(null);
    setError(null);
    setMode('idle');
    setOther('');
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

  useEffect(() => {
    if (startWithOtherAmount && w?.actions.includes('other_amount') && mode === 'idle') setMode('other');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startWithOtherAmount, w?.id, w?.actions.length]);

  const act = async (fn: () => Promise<WithdrawalDto>) => {
    setBusy(true);
    setError(null);
    try {
      const x = await fn();
      setW(x);
      setMode('idle');
      hapticNotify('success');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      hapticNotify('error');
    } finally {
      setBusy(false);
    }
  };

  // "Not yet" changes nothing in the deal: it only tells the operator the user is there, so the sheet just folds away.
  const notYet = async () => {
    if (!w) return;
    haptic();
    setBusy(true);
    setError(null);
    try {
      await api.dealNotYet(w.id);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      hapticNotify('error');
    } finally {
      setBusy(false);
    }
  };

  const now = Date.now() + skew;
  const can = (a: WithdrawalDto['actions'][number]) => !!w?.actions.includes(a);
  const otherRub = Number(other.replace(/\D/g, ''));
  const support = supportUsername ? (
    <button className="btn ghost block" onClick={() => openTelegramChat(supportUsername)}>Написать в поддержку</button>
  ) : null;

  return (
    <Sheet open={id !== null} onClose={onClose} title={w ? `Заявка №${w.id}` : 'Заявка'}>
      {!w && !error && <div className="skeleton" style={{ height: 160 }} />}
      {w && (
        <div className="wd">
          <div className={`wd-status s-${tone(w.status)}`}>
            <span className="wd-status-icon">
              {tone(w.status) === 'completed' ? <IconCheck size={18} /> : w.status === 'cancelled' ? <IconClose size={16} /> : tone(w.status) === 'disputed' ? <IconAlert size={16} /> : <IconClock size={18} />}
            </span>
            {userStatusLabel({ status: w.status, enteredAt: w.enteredAt }, now)}
          </div>
          <div className="wd-amount">{fmtRub0(w.finalRub ?? w.amountRub)}</div>
          <div className="muted wd-dest">{w.destination}</div>

          {w.actions.length === 0 && (w.status === 'new' || w.status === 'in_work' || w.status === 'entered') && (
            <Notice tone="info">Заявка в работе. Мы пришлём уведомление, когда деньги начнут путь.</Notice>
          )}

          {w.actions.length > 0 && mode === 'idle' && (
            <div className="confirm-box">
              <b>{boxTitle(w)}</b>
              <p>{boxText(w)}</p>
              {w.status === 'entered' && w.enteredAt && (
                <div className="countdown">
                  <IconClock size={15} /> Осталось {fmtCountdown(w.enteredAt + INACTIVE_AFTER_MS - now)}
                </div>
              )}
              <div className="deal-actions">
                {can('received') && (
                  <button className="btn success block" disabled={busy} onClick={() => { haptic(); setMode('confirm'); }}>
                    {w.status === 'entered' ? 'Подтвердить получение' : 'Оплата поступила'}
                  </button>
                )}
                {can('not_yet') && (
                  <button className="btn ghost block" disabled={busy} onClick={notYet}>Оплата ещё не поступила</button>
                )}
                {can('other_amount') && (
                  <button className="btn ghost block" disabled={busy} onClick={() => { haptic(); setMode('other'); }}>Поступила другая сумма</button>
                )}
                {can('not_received') && (
                  <button className="btn ghost block danger-text" disabled={busy} onClick={() => { haptic(); setMode('not'); }}>Оплата не поступила</button>
                )}
              </div>
            </div>
          )}

          {mode === 'confirm' && (
            <div className="confirm-box">
              <b>Вам поступила сумма {fmtRub0(w.amountRub)}?</b>
              <p>После подтверждения сделка завершится, изменить решение будет нельзя.</p>
              <div className="sheet-actions">
                <button className="btn ghost" disabled={busy} onClick={() => setMode('idle')}>Назад</button>
                <button className="btn success" disabled={busy} onClick={() => act(() => api.dealReceived(w.id))}>Да, поступила</button>
              </div>
            </div>
          )}

          {mode === 'other' && (
            <div className="confirm-box">
              <b>Какая сумма поступила?</b>
              <p>Укажите сумму, которая фактически пришла на счёт. Мы проверим и пересчитаем сделку по курсу заявки.</p>
              <div className="input with-suffix">
                <input
                  inputMode="numeric"
                  autoFocus
                  placeholder={fmtRub0(w.amountRub).replace(' ₽', '')}
                  value={otherRub ? otherRub.toLocaleString('ru-RU') : ''}
                  onChange={(e) => setOther(e.target.value.replace(/\D/g, '').slice(0, 8))}
                />
                <span className="suffix">₽</span>
              </div>
              <div className="sheet-actions">
                <button className="btn ghost" disabled={busy} onClick={() => setMode('idle')}>Назад</button>
                <button className="btn primary" disabled={busy || !otherRub} onClick={() => act(() => api.dealOtherAmount(w.id, otherRub))}>Отправить</button>
              </div>
            </div>
          )}

          {mode === 'not' && (
            <div className="dispute-box">
              <b>Оплата не поступила?</b>
              <p>Проверьте историю операций в банке. После этого с вами свяжется поддержка и поможет разобраться. Если деньги придут позже, подтвердите получение здесь.</p>
              <div className="sheet-actions">
                <button className="btn ghost" disabled={busy} onClick={() => setMode('idle')}>Назад</button>
                <button className="btn danger" disabled={busy} onClick={() => act(() => api.dealNotReceived(w.id))}>Не поступила</button>
              </div>
            </div>
          )}

          {(w.status === 'not_received' || w.status === 'mismatch' || w.status === 'inactive') && mode === 'idle' && support}

          {(w.status === 'user_confirmed' || w.status === 'completed') && (
            <Notice tone="info">
              {w.resolution === 'correction'
                ? `Сделка завершена по сумме ${fmtRub0(w.finalRub ?? w.amountRub)}.${w.refundedMicro ? ` ${fmtMicro(w.refundedMicro)} вернулись на баланс.` : ''}`
                : 'Выплата завершена. Спасибо!'}
            </Notice>
          )}
          {w.status === 'cancelled' && <Notice tone="danger">Заявка отменена. {fmtMicro(w.amountMicro)} вернулись на баланс.</Notice>}

          {error && <Notice tone="danger">{error}</Notice>}

          <div className="kv-list">
            <Kv k="Способ" v={w.method === 'sbp' ? 'СБП' : 'На карту'} />
            <Kv k={w.debitedMicro !== null ? 'Списано' : 'Заморожено'} v={fmtMicro(w.debitedMicro ?? (w.status === 'cancelled' ? 0 : w.amountMicro))} />
            <Kv k="Курс" v={`1 USDT = ${fmtRub(w.rate)}`} />
            {w.reportedRub !== null && w.status === 'mismatch' && <Kv k="Вы сообщили" v={fmtRub0(w.reportedRub)} />}
            <Kv k="Создана" v={fmtDateTime(w.createdAt)} />
            {w.finishedAt && <Kv k={w.status === 'cancelled' ? 'Отменена' : 'Завершена'} v={fmtDateTime(w.finishedAt)} />}
          </div>
        </div>
      )}
      {!w && error && <Notice tone="danger">{error}</Notice>}
    </Sheet>
  );
}

function boxTitle(w: WithdrawalDto): string {
  switch (w.status) {
    case 'not_received':
      return 'Проверяем платёж';
    case 'mismatch':
      return 'Проверяем сумму';
    case 'inactive':
      return 'Время на подтверждение вышло';
    default:
      return 'Деньги начали путь';
  }
}

function boxText(w: WithdrawalDto): string {
  switch (w.status) {
    case 'not_received':
      return 'Вы сообщили, что оплата не поступила. С вами свяжется поддержка. Если деньги пришли, подтвердите получение.';
    case 'mismatch':
      return `Вы сообщили о сумме ${fmtRub0(w.reportedRub ?? 0)}. Если сумма другая, отправьте её снова.`;
    case 'inactive':
      return 'Кошелёк приостановлен, пока вы не ответите. Поступила ли оплата?';
    default:
      return `Проверьте счёт и подтвердите поступление ${fmtRub0(w.amountRub)}. Чем быстрее вы подтверждаете, тем выше ваш рейтинг и тем выгоднее курс для вас.`;
  }
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}
