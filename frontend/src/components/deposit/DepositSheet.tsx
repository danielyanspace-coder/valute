import { useCallback, useEffect, useState } from 'react';
import type { DepositInfoDto, DepositRequestDto } from '../../../../shared/api';
import { DEPOSIT_REQUEST_TTL_MS } from '../../../../shared/deposits';
import { shortUsdt } from '../../../../shared/transfers';
import { ApiError } from '../../lib/api';
import { api } from '../../lib/backend';
import { fmtCountdown } from '../../lib/format';
import { copyText, haptic, hapticNotify } from '../../lib/telegram';
import { CoinIcon } from '../CoinIcon';
import { IconAlert, IconCheck, IconClock, IconCopy } from '../icons';
import { Sheet } from '../Sheet';
import { QrCode } from './QrCode';

const TTL_MIN = DEPOSIT_REQUEST_TTL_MS / 60_000;

/**
 * Deposit screen: USDT on TRON (TRC-20) only. The user asks for an address and gets one
 * for 15 minutes; nobody else gets it meanwhile. A new request needs the old one cancelled.
 */
export function DepositSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [info, setInfo] = useState<DepositInfoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUntil, setBusyUntil] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [skew, setSkew] = useState(0);
  const [, tick] = useState(0);

  const apply = useCallback((x: DepositInfoDto) => {
    setInfo(x);
    if (x.request) setSkew(x.request.serverNow - Date.now());
  }, []);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setError(null);
    setBusyUntil(null);
    setConfirmCancel(false);
    let alive = true;
    const load = () => api.deposit().then((x) => alive && apply(x), (e) => alive && setError((e as Error).message));
    load();
    const poll = setInterval(load, 5000);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(t);
    };
  }, [open, apply]);

  const now = Date.now() + skew;
  const r = info?.request ?? null;
  const active = r?.status === 'active' && r.expiresAt > now ? r : null;
  const min = info?.minDepositMicro ? shortUsdt(info.minDepositMicro) : null;
  const anyAmount = min ? `любую сумму от ${min} USDT` : 'любую сумму';

  const run = async (fn: () => Promise<DepositInfoDto>) => {
    setBusy(true);
    setError(null);
    setBusyUntil(null);
    try {
      apply(await fn());
      haptic();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'pool_busy') setBusyUntil(Number(e.extra.retryAt) || null);
      else setError((e as Error).message);
      hapticNotify('error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!active) return;
    haptic();
    if (await copyText(active.address)) {
      hapticNotify('success');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Пополнить">
      <div className="deposit">
        <div className="dep-asset">
          <CoinIcon symbol="USDT" size={42} />
          <div className="dep-asset-text">
            <b>USDT</b>
            <span className="muted">Tether</span>
          </div>
          <span className="dep-network"><TronMark /> TRON · TRC-20</span>
        </div>

        {!info ? (
          <Placeholder title={error ? 'Не удалось загрузить' : 'Загружаем…'} text={error ?? ''} />
        ) : !info.enabled && !r ? (
          <Placeholder title="Пополнение временно недоступно" text="Мы уже настраиваем приём USDT. Загляните чуть позже." />
        ) : active ? (
          <div className="dep-card">
            <div className={`dep-timer ${active.expiresAt - now < 3 * 60_000 ? 'hot' : ''} ${active.expiresAt - now < 60_000 ? 'last' : ''}`}>
              <IconClock size={15} /> Осталось {fmtCountdown(active.expiresAt - now)}
            </div>
            <div className="dep-qr"><QrCode value={active.address} size={208} /></div>
            <span className="dep-label">Адрес для пополнения, только для вас</span>
            <div className="dep-address" onClick={copy}>
              <span className="hl">{active.address.slice(0, 6)}</span>
              {active.address.slice(6, -6)}
              <span className="hl">{active.address.slice(-6)}</span>
            </div>
            {info.demo && <span className="dep-demo">Демо-адрес, он не настоящий. Не отправляйте на него средства</span>}
            <button className="btn primary dep-copy" onClick={copy}>
              {copied ? <span className="copied-pop"><IconCheck size={16} /> Скопировано</span> : <><IconCopy size={16} /> Скопировать адрес</>}
            </button>
            {confirmCancel ? (
              <div className="dep-cancel-confirm">
                <span>Отменить заявку? Если вы уже отправили USDT, не отменяйте: деньги зачислятся сами.</span>
                <div className="dep-actions">
                  <button className="btn ghost" disabled={busy} onClick={() => setConfirmCancel(false)}>Назад</button>
                  <button className="btn danger" disabled={busy} onClick={async () => (await run(api.depositCancel)) && setConfirmCancel(false)}>Отменить</button>
                </div>
              </div>
            ) : (
              <button className="dep-cancel" onClick={() => setConfirmCancel(true)}>Отменить заявку</button>
            )}
          </div>
        ) : (
          <ResultCard r={r} now={now} anyAmount={anyAmount} busy={busy} busyUntil={busyUntil} onOpen={() => run(api.depositOpen)} />
        )}
        {error && info && <div className="dep-error">{error}</div>}

        <div className="dep-warning">
          <IconAlert size={18} />
          <p>
            Отправляйте только <b>USDT</b> в сети <b>TRON (TRC-20)</b>. Другие монеты и сети (ERC-20, BEP-20, TON) не зачислятся,
            и вернуть их не получится.
          </p>
        </div>

        <div className="kv-list dep-facts">
          <div className="kv"><span className="muted">Сеть</span><span>TRON (TRC-20)</span></div>
          <div className="kv"><span className="muted">Сумма</span><span>{min ? `от ${min} USDT` : 'Любая'}</span></div>
          <div className="kv"><span className="muted">Время на перевод</span><span>{TTL_MIN} минут</span></div>
          <div className="kv"><span className="muted">Зачисление</span><span>{info?.confirmations ?? 20} подтверждений, 1-2 минуты</span></div>
          <div className="kv"><span className="muted">Комиссия кошелька</span><span className="up">0 USDT</span></div>
        </div>

        <div className="dep-steps">
          <b>Как пополнить</b>
          <ol>
            <li>Нажмите «Получить адрес». Он закрепится за вами на {TTL_MIN} минут.</li>
            <li>На бирже или в кошельке выберите вывод USDT, сеть <b>TRC-20</b>, и отправьте {anyAmount}.</li>
            <li>Деньги появятся на балансе автоматически, бот пришлёт уведомление.</li>
          </ol>
          <p className="muted small">
            Адрес каждый раз может быть новым. Не сохраняйте его и не отправляйте на старый адрес без новой заявки. Все поступления проходят
            автоматическую AML-проверку.
          </p>
        </div>
      </div>
    </Sheet>
  );
}

/** No open request: either nothing yet, or the last one just ended (paid or expired). */
function ResultCard({ r, now, anyAmount, busy, busyUntil, onOpen }: {
  r: DepositRequestDto | null;
  now: number;
  anyAmount: string;
  busy: boolean;
  busyUntil: number | null;
  onOpen: () => void;
}) {
  const paid = r && (r.status === 'paid' || r.receivedMicro > 0);
  const expired = r && !paid && (r.status === 'expired' || r.expiresAt <= now);
  const wait = busyUntil ? Math.max(1, Math.ceil((busyUntil - now) / 60_000)) : null;
  return (
    <div className={`dep-card pending ${paid ? 'ok' : ''}`}>
      <div className={`dep-state-icon ${paid ? 'ok' : expired ? 'warn' : ''}`}>{paid ? <IconCheck size={26} /> : expired ? <IconClock size={26} /> : <CoinIcon symbol="USDT" size={44} />}</div>
      {paid ? (
        <>
          <b className="dep-pending-title">{r.creditedMicro >= r.receivedMicro ? 'Зачислено' : 'Платёж получен'}: {shortUsdt(r.receivedMicro)} USDT</b>
          <p className="muted dep-pending-text">
            {r.creditedMicro >= r.receivedMicro
              ? 'Деньги уже на балансе.'
              : 'Зачислим на баланс после подтверждения сети, обычно 1-2 минуты. Бот пришлёт уведомление.'}
          </p>
        </>
      ) : expired ? (
        <>
          <b className="dep-pending-title">Время на перевод вышло</b>
          <p className="muted dep-pending-text">
            Если вы уже отправили USDT, ничего делать не нужно: деньги зачислятся автоматически. Новые переводы на тот адрес не отправляйте.
          </p>
        </>
      ) : (
        <>
          <b className="dep-pending-title">Пополнение через USDT TRC-20</b>
          <p className="muted dep-pending-text">Получите адрес и в течение {TTL_MIN} минут отправьте на него {anyAmount}.</p>
        </>
      )}
      {wait !== null && <div className="dep-busy">Все адреса сейчас заняты. Попробуйте через {wait} мин.</div>}
      <button className="btn primary dep-copy" disabled={busy} onClick={onOpen}>
        {busy ? 'Получаем адрес…' : paid || expired ? 'Новое пополнение' : 'Получить адрес'}
      </button>
    </div>
  );
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="dep-card pending">
      <div className="dep-state-icon"><IconClock size={26} /></div>
      <b className="dep-pending-title">{title}</b>
      {text && <p className="muted dep-pending-text">{text}</p>}
    </div>
  );
}

function TronMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#eb0029" />
      <g fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M6 6.8 18.2 9.4 11.6 18.6Z" />
        <path d="M6 6.8 13.6 11.2 18.2 9.4M13.6 11.2 11.6 18.6" />
      </g>
    </svg>
  );
}
