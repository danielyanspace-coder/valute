import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminBoardDto, AdminWithdrawalListItem } from '../../../shared/api';
import { BOARD_SECTIONS, REMINDER_COUNT, type AdminDealAction, type BoardSection } from '../../../shared/deals';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtCountdown, fmtRub0 } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { DealDrawer } from './DealDetail';
import { INSTANT, confirmFor, runInstant } from './dealActions';
import { ConfirmDialog, ContactDialog, CopyChip, PayoutLogo, useNow, type ConfirmRequest } from './ui';

/** Sections that make a sound when a new deal lands in them. */
const LOUD: BoardSection[] = ['new', 'user_confirmed', 'mismatch', 'not_received', 'inactive'];
const SOUND_KEY = 'adminSound';

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.35);
    navigator.vibrate?.(200);
  } catch {
    // audio blocked until the first click: fine
  }
}

/** Main screen: every active deal as a card, most urgent sections first. */
export function DealsBoard({ api, onOpenUser }: { api: AdminApi; onOpenUser: (id: number) => void }) {
  const [board, setBoard] = useState<AdminBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [contact, setContact] = useState<AdminWithdrawalListItem['user'] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const seen = useRef<Map<number, BoardSection | null> | null>(null);

  const load = useCallback(() => {
    api.board().then(
      (b) => {
        setBoard(b);
        setError(null);
        const prev = seen.current;
        const next = new Map(b.items.map((i) => [i.id, i.section]));
        if (prev && sound && b.items.some((i) => i.section && LOUD.includes(i.section) && prev.get(i.id) !== i.section)) beep();
        seen.current = next;
      },
      (e) => setError((e as Error).message),
    );
  }, [api, sound]);
  usePolling(load, 3000);

  const now = useNow(board ? board.serverNow - Date.now() : 0);
  const attention = board ? BOARD_SECTIONS.filter((s) => s.id !== 'in_work' && s.id !== 'awaiting').reduce((n, s) => n + board.counts[s.id], 0) : 0;
  useEffect(() => {
    document.title = attention ? `(${attention}) Сделки · Crypto IX` : 'Сделки · Crypto IX';
  }, [attention]);

  const act = async (d: AdminWithdrawalListItem, action: AdminDealAction) => {
    if (INSTANT.includes(action)) {
      setBusy(d.id);
      try {
        await runInstant(api, d, action);
        load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
      return;
    }
    try {
      setConfirm(await confirmFor(api, d, action, load));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleSound = () => {
    setSound((s) => {
      try {
        localStorage.setItem(SOUND_KEY, s ? 'off' : 'on');
      } catch {
        /* ignore */
      }
      if (!s) beep();
      return !s;
    });
  };

  if (!board) return <div className="adm-empty">{error ?? 'Загружаем сделки…'}</div>;
  const sections = BOARD_SECTIONS.filter((s) => board.counts[s.id] > 0);

  return (
    <div className="ab-board">
      <div className="ab-summary">
        {BOARD_SECTIONS.map((s) => (
          <a key={s.id} href={`#sec-${s.id}`} className={`ab-sum s-${s.id} ${board.counts[s.id] ? '' : 'zero'}`}>
            <span className="ab-sum-n">{board.counts[s.id]}</span>
            <span className="ab-sum-l">{s.title}</span>
          </a>
        ))}
        <button className="ab-sound" onClick={toggleSound} title="Звук при новых сделках">{sound ? '🔔' : '🔕'}</button>
      </div>
      {error && <div className="adm-error">{error}</div>}
      {sections.length === 0 && <div className="adm-empty">Активных сделок нет. Новые заявки появятся здесь автоматически.</div>}
      <div className="ab-sections">
      {sections.map((s) => (
        <section key={s.id} id={`sec-${s.id}`} className={`ab-section s-${s.id}`}>
          <h2 className="ab-section-title">
            <span className="ab-dot" /> {s.title} <span className="ab-count">{board.counts[s.id]}</span>
            <span className="ab-hint">{s.hint}</span>
          </h2>
          <div className="ab-grid">
            {board.items
              .filter((d) => d.section === s.id)
              .map((d) => (
                <DealCard key={d.id} d={d} now={now} busy={busy === d.id} onOpen={() => setOpen(d.id)} onAction={(a) => act(d, a)} onContact={() => setContact(d.user)} />
              ))}
          </div>
        </section>
      ))}
      </div>

      {open !== null && <DealDrawer api={api} id={open} onClose={() => setOpen(null)} onChanged={load} onOpenUser={onOpenUser} onOpenDeal={setOpen} />}
      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(null)} />}
      {contact && <ContactDialog api={api} user={contact} onClose={() => setContact(null)} onDone={() => { setContact(null); load(); }} />}
    </div>
  );
}

function Btn({ children, tone, onClick, disabled }: { children: ReactNode; tone: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={`ab-btn ${tone}`} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

export function DealCard({ d, now, busy, onOpen, onAction, onContact }: {
  d: AdminWithdrawalListItem;
  now: number;
  busy: boolean;
  onOpen: () => void;
  onAction: (a: AdminDealAction) => void;
  onContact: () => void;
}) {
  const platformLeft = d.platformDeadline ? d.platformDeadline - now : null;
  const platform = platformLeft !== null && (d.section === 'requisite' || d.section === 'user_confirmed' || d.section === 'awaiting') && (
    <div className={`ab-timer ${platformLeft < 3 * 60_000 ? 'hot' : ''}`}>
      {platformLeft > 0 ? `До слёта площадки ${fmtCountdown(platformLeft)}` : 'Таймер площадки истёк'}
    </div>
  );
  return (
    <div className={`ab-card s-${d.section}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="ab-card-top">
        <b className="ab-no">№{d.id}</b>
        <span className="ab-age">{fmtAgo(d.createdAt, now)}</span>
      </div>
      <div className="ab-amount">{fmtRub0(d.amountRub)}</div>
      <div className="ab-dest">
        <PayoutLogo method={d.method} bankId={d.bankId} destination={d.destination} size={22} />
        <span>{d.method === 'sbp' ? `СБП · ${d.bankName ?? ''}` : d.destination.split(' ')[0] + ' · карта'}</span>
      </div>

      {d.section === 'in_work' && (
        <div className="ab-copies" onClick={(e) => e.stopPropagation()}>
          <CopyChip label="Сумма" value={String(d.amountRub)} />
          <CopyChip label={d.method === 'sbp' ? 'Телефон' : 'Карта'} value={d.requisite.replace(/\s*\(.*\)$/, '').replace(/[\s-]/g, '')} />
          {d.bankName && <CopyChip label="Банк" value={d.bankName} />}
        </div>
      )}
      {d.section === 'requisite' && <div className="ab-reminder">Отключите приём сделок для реквизита <b>{d.requisite}</b>. После отключения нажмите «ОТКЛЮЧИЛ».</div>}
      {d.section === 'awaiting' && d.inactiveAt && (
        <div className="ab-line">
          Уведомление {d.remindersSent}/{REMINDER_COUNT} · неактивен через {fmtCountdown(d.inactiveAt - now)}
        </div>
      )}
      {d.status === 'entered' && d.userActiveAt && <div className="ab-line t-ok">На связи: «ещё не поступила» {fmtAgo(d.userActiveAt, now)}</div>}
      {d.section === 'user_confirmed' && <div className="ab-line">Подтвердил {d.userDecidedAt ? fmtAgo(d.userDecidedAt, now) : ''}</div>}
      {d.section === 'not_received' && <div className="ab-line">{d.userDecidedAt ? `Сообщил ${fmtAgo(d.userDecidedAt, now)}` : 'Возвращена на рассмотрение'}</div>}
      {d.section === 'mismatch' && <div className="ab-line">Получил <b>{fmtRub0(d.reportedRub ?? 0)}</b> вместо {fmtRub0(d.amountRub)}</div>}
      {d.section === 'inactive' && <div className="ab-line">Не ответил на {REMINDER_COUNT} уведомлений</div>}
      {d.section !== 'requisite' && d.enteredAt && !d.requisiteOffAt && <div className="ab-reminder small">Реквизит {d.requisite} не отмечен как отключённый</div>}
      {platform}
      {(d.user.supportLocked || d.user.botBlocked) && (
        <div className="ab-flags">
          {d.user.supportLocked && <span className="ab-flag">Заблокирован до связи</span>}
          {d.user.botBlocked && <span className="ab-flag">Бот заблокирован</span>}
        </div>
      )}

      <div className="ab-card-actions">
        {d.section === 'new' && <Btn tone="primary" disabled={busy} onClick={() => onAction('take')}>Взять в работу</Btn>}
        {d.section === 'in_work' && <Btn tone="warn" disabled={busy} onClick={() => onAction('entered')}>В сделку вошли</Btn>}
        {d.section === 'requisite' && <Btn tone="warn" disabled={busy} onClick={() => onAction('requisite_off')}>ОТКЛЮЧИЛ</Btn>}
        {d.section === 'user_confirmed' && <Btn tone="success" disabled={busy} onClick={() => onAction('close')}>Подтверждено / Закрыть</Btn>}
        {d.section === 'not_received' && (
          <>
            <Btn tone="success" disabled={busy} onClick={() => onAction('confirm')}>Подтвердить</Btn>
            <Btn tone="danger" disabled={busy} onClick={() => onAction('cancel')}>Отменить</Btn>
          </>
        )}
        {d.section === 'mismatch' && (
          <>
            <Btn tone="primary" disabled={busy} onClick={() => onAction('accept_correction')}>Принять корректировку</Btn>
            <Btn tone="ghost" disabled={busy} onClick={() => onAction('accept_original')}>По сумме сделки</Btn>
          </>
        )}
        {d.section === 'inactive' && (
          <>
            <Btn tone="success" disabled={busy} onClick={() => onAction('confirm')}>Подтвердить вручную</Btn>
            <Btn tone="contact" onClick={onContact}>Связаться</Btn>
          </>
        )}
        {d.section !== 'requisite' && d.enteredAt && !d.requisiteOffAt && !d.finishedAt && (
          <Btn tone="ghost" disabled={busy} onClick={() => onAction('requisite_off')}>ОТКЛЮЧИЛ</Btn>
        )}
      </div>
    </div>
  );
}
