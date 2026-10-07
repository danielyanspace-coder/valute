// Building blocks shared by every admin section.
import { useEffect, useState, type ReactNode } from 'react';
import type { AdminUserDto } from '../../../shared/api';
import { findBank } from '../../../shared/sbpBanks';
import { MirMark, SbpMark } from '../components/brandMarks';
import { BankAvatar } from '../components/withdraw/BankPicker';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtMicroExact } from '../lib/format';

export const ACTOR = { user: 'Пользователь', admin: 'Админ', system: 'Система' } as const;

/** Re-renders every second: countdowns on cards. */
export function useNow(skew = 0): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return Date.now() + skew;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="adm-card">
      <div className="adm-card-head">
        <div className="adm-card-title">{title}</div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function Row(props: { k: string; v: string; sub?: string; icon?: ReactNode; copy?: string; href?: string; big?: boolean; mono?: boolean; small?: boolean; tone?: 'ok' | 'warn' | 'danger' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyToClipboard(props.copy!)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  const cls = ['adm-v', props.big && 'big', props.mono && 'mono', props.small && 'small', props.tone && `t-${props.tone}`].filter(Boolean).join(' ');
  return (
    <div className="adm-kv">
      <span className="adm-k">{props.k}</span>
      <span className={`adm-v-wrap ${props.icon ? 'with-icon' : ''}`}>
        {props.icon}
        {props.href ? (
          <a className={cls} href={props.href} target="_blank" rel="noreferrer">{props.v}</a>
        ) : (
          <span className={cls}>{props.v}</span>
        )}
        {props.sub && <span className="adm-muted small">{props.sub}</span>}
      </span>
      {props.copy && <button className="adm-copy" onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</button>}
    </div>
  );
}

/** Small "copy" chip for card quick actions. */
export function CopyChip({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`ab-copy ${done ? 'done' : ''}`}
      onClick={async (e) => {
        e.stopPropagation();
        if (await copyToClipboard(value)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? 'Скопировано' : label}
    </button>
  );
}

export function TwoStep(props: { label: string; confirm: string; tone: 'primary' | 'success'; busy: boolean; onConfirm: () => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return <button className={`adm-btn ${props.tone}`} disabled={props.busy} onClick={() => setAsking(true)}>{props.label}</button>;
  }
  return (
    <div className="adm-inline confirm">
      <span>{props.confirm}</span>
      <button className={`adm-btn ${props.tone}`} disabled={props.busy} onClick={async () => { await props.onConfirm(); setAsking(false); }}>Да</button>
      <button className="adm-link" onClick={() => setAsking(false)}>Отмена</button>
    </div>
  );
}

// ---------- Modal + confirm ----------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ab-modal-back" onClick={onClose}>
      <div className={`ab-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ab-modal-head">
          <b>{title}</b>
          <button className="ab-x" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface ConfirmRequest {
  title: string;
  /** What will happen, in one or two short lines. */
  text: ReactNode;
  confirmLabel: string;
  tone: 'primary' | 'success' | 'danger' | 'warn';
  /** Archiving actions offer to set the operator's own deal ID first. */
  askExternalId?: boolean;
  /** Free-text field (e.g. cancel reason), optional. */
  reasonLabel?: string;
  /** Extra checkbox (e.g. "create a shadow hold for the shortage"). */
  checkbox?: { label: string; defaultChecked: boolean };
  run: (input: { externalId: string; reason: string; checked: boolean }) => Promise<unknown>;
}

/** One confirmation window for every critical action. */
export function ConfirmDialog({ req, onClose }: { req: ConfirmRequest; onClose: () => void }) {
  const [externalId, setExternalId] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(req.checkbox?.defaultChecked ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await req.run({ externalId: externalId.trim(), reason: reason.trim(), checked });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={req.title} onClose={onClose}>
      <div className="ab-confirm-text">{req.text}</div>
      {req.reasonLabel && (
        <label className="adm-field">
          <span>{req.reasonLabel}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Необязательно" />
        </label>
      )}
      {req.checkbox && (
        <label className="ab-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{req.checkbox.label}</span>
        </label>
      )}
      {req.askExternalId && (
        <label className="adm-field">
          <span>ID сделки для архива</span>
          <input
            id="external-id"
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            placeholder="Например, номер сделки на площадке. Можно пропустить"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && !busy && submit()}
          />
        </label>
      )}
      {error && <div className="adm-error">{error}</div>}
      <div className="ab-modal-actions">
        <button className="adm-btn ghost-lg" onClick={onClose} disabled={busy}>Отмена</button>
        <button className={`adm-btn ${req.tone} big`} onClick={submit} disabled={busy}>
          {busy ? 'Выполняем…' : req.askExternalId && !externalId.trim() ? `${req.confirmLabel} без ID` : req.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- User bits ----------

export function BlockToggle({ api, userId, blocked, onDone }: { api: AdminApi; userId: number; blocked: boolean; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className={`adm-btn small ${blocked ? '' : 'danger-ghost'}`} onClick={() => setAsking(true)}>
        {blocked ? 'Разрешить вывод' : 'Запретить вывод'}
      </button>
    );
  }
  return (
    <div className="adm-inline confirm">
      <span>{blocked ? 'Вернуть доступ к выводу?' : 'Пользователь не сможет создавать заявки на вывод.'}</span>
      <button className="adm-btn small" onClick={async () => { await api.setBlocked(userId, !blocked); setAsking(false); onDone(); }}>Да</button>
      <button className="adm-link" onClick={() => setAsking(false)}>Отмена</button>
    </div>
  );
}

export function Adjust({ api, userId, onDone }: { api: AdminApi; userId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button className="adm-btn small" onClick={() => setOpen(true)}>Корректировка баланса</button>;
  const submit = async () => {
    setError(null);
    try {
      await api.adjustBalance(userId, Number(amount.replace(',', '.')), comment);
      setOpen(false);
      setAmount('');
      setComment('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="adm-adjust">
      <input id="adjust-amount" placeholder="USDT, например 50 или -10" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input id="adjust-comment" placeholder="Причина, попадёт в журнал" value={comment} onChange={(e) => setComment(e.target.value)} />
      {error && <div className="adm-error">{error}</div>}
      <div className="adm-inline">
        <button className="adm-btn primary small" disabled={!amount || !comment.trim()} onClick={submit}>Применить</button>
        <button className="adm-link" onClick={() => setOpen(false)}>Отмена</button>
      </div>
    </div>
  );
}

/** "Force to contact support": blocks every action in the bot and the Mini App. */
export function SupportLockButton({ api, user, onDone }: { api: AdminApi; user: { id: number; supportLocked: boolean }; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button className={`adm-btn ${user.supportLocked ? 'warn' : 'danger-ghost'}`} onClick={() => setConfirm(true)}>
        {user.supportLocked ? 'Снять блокировку' : 'Заставить связаться с поддержкой'}
      </button>
      {confirm && (
        <ConfirmDialog
          onClose={() => setConfirm(false)}
          req={{
            title: user.supportLocked ? 'Снять блокировку?' : 'Заставить связаться с поддержкой?',
            text: user.supportLocked
              ? 'Пользователь снова сможет пользоваться кошельком. Бот пришлёт ему сообщение.'
              : 'Все действия пользователя будут заблокированы. В боте и в Mini App появится окно «Свяжитесь с поддержкой» с кнопкой чата поддержки.',
            confirmLabel: user.supportLocked ? 'Снять' : 'Заблокировать',
            tone: user.supportLocked ? 'primary' : 'danger',
            run: async () => {
              await api.setSupportLock(user.id, !user.supportLocked);
              onDone();
            },
          }}
        />
      )}
    </>
  );
}

/** Bank logo for SBP payouts, Mir mark for Mir cards, a neutral card tile otherwise. */
export function PayoutLogo({ method, bankId, destination, size }: { method: 'sbp' | 'card'; bankId: string | null; destination: string; size: number }) {
  if (method === 'sbp') {
    const bank = bankId ? findBank(bankId) : undefined;
    if (bank) return <BankAvatar bank={bank} size={size} />;
    return <span className="adm-logo-tile" style={{ width: size, height: size }}><SbpMark size={size * 0.62} /></span>;
  }
  return (
    <span className="adm-logo-tile" style={{ width: size, height: size }}>
      {destination.startsWith('МИР') ? <MirMark width={size * 0.82} /> : <span className="adm-card-brand">{destination.split(' ')[0]}</span>}
    </span>
  );
}

export const tgLink = (u: { username: string | null; telegramId: number }) =>
  u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.telegramId}`;

export function UserCard({ u, api, onDone, onOpenUser }: { u: AdminUserDto; api: AdminApi; onDone: () => void; onOpenUser?: (id: number) => void }) {
  return (
    <Card title="Пользователь" actions={onOpenUser && <button className="adm-link" onClick={() => onOpenUser(u.id)}>Открыть профиль</button>}>
      <Row k="Имя" v={[u.firstName, u.lastName].filter(Boolean).join(' ')} />
      <Row k="Username" v={u.username ? `@${u.username}` : 'Скрыт'} href={u.username ? `https://t.me/${u.username}` : undefined} tone={u.username ? undefined : 'warn'} />
      <Row k="Telegram ID" v={String(u.telegramId)} copy={String(u.telegramId)} />
      <Row k="ID в системе" v={String(u.id)} />
      <Row k="Регистрация" v={`${fmtDateTime(u.createdAt)} (${fmtAgo(u.createdAt)})`} />
      <Row k="Последний вход" v={fmtAgo(u.lastSeenAt)} />
      <Row k="Бот" v={u.botBlockedAt ? `Заблокирован пользователем ${fmtAgo(u.botBlockedAt)}` : 'Доставляется'} tone={u.botBlockedAt ? 'danger' : 'ok'} />
      <Row k="Неактивен в сделках" v={`${u.missedConfirmations} раз`} tone={u.missedConfirmations >= 2 ? 'danger' : u.missedConfirmations === 1 ? 'warn' : undefined} />
      <Row k="Доступно" v={fmtMicroExact(u.availableMicro)} />
      <Row k="Заморожено" v={fmtMicroExact(u.frozenMicro)} />
      {u.obligationsLeftMicro > 0 && <Row k="Теневая заморозка" v={`${fmtMicroExact(u.obligationsLeftMicro)} к удержанию`} tone="warn" />}
      <Row k="Вывод" v={u.blocked ? 'Запрещён' : 'Разрешён'} tone={u.blocked ? 'danger' : 'ok'} />
      <Row k="Поддержка" v={u.supportLockedAt ? `Заблокирован до связи с ${fmtDateTime(u.supportLockedAt)}` : 'Без блокировки'} tone={u.supportLockedAt ? 'danger' : undefined} />
      <div className="ab-user-actions">
        <SupportLockButton api={api} user={{ id: u.id, supportLocked: !!u.supportLockedAt }} onDone={onDone} />
        <BlockToggle api={api} userId={u.id} blocked={u.blocked} onDone={onDone} />
        <Adjust api={api} userId={u.id} onDone={onDone} />
      </div>
    </Card>
  );
}

/** Opens the client's Telegram chat: by username, or by numeric id when the username is hidden. */
export function ContactClient({ user }: { user: { username: string | null; telegramId: number } }) {
  return (
    <a className="adm-btn contact" href={tgLink(user)} target="_blank" rel="noreferrer">
      Связаться с клиентом{user.username ? '' : ' (по ID)'}
    </a>
  );
}

/** "Связаться с пользователем": username, chat link, ID and the support lock. */
export function ContactDialog({
  api,
  user,
  onClose,
  onDone,
}: {
  api: AdminApi;
  user: { id: number; username: string | null; firstName: string; telegramId: number; supportLocked: boolean; botBlocked: boolean };
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal title="Связаться с пользователем" onClose={onClose}>
      <div className="adm-kv-list">
        <Row k="Имя" v={user.firstName} />
        <Row k="Username" v={user.username ? `@${user.username}` : 'Скрыт'} copy={user.username ? `@${user.username}` : undefined} tone={user.username ? undefined : 'warn'} />
        <Row k="Telegram ID" v={String(user.telegramId)} copy={String(user.telegramId)} />
        {user.botBlocked && <Row k="Бот" v="Пользователь заблокировал бота" tone="danger" />}
      </div>
      {!user.username && (
        <p className="adm-muted small">Username скрыт: ссылка по ID откроется не во всех версиях Telegram. Если не получится, заблокируйте кошелёк до связи с поддержкой.</p>
      )}
      <div className="ab-modal-actions">
        <a className="adm-btn contact big" href={tgLink(user)} target="_blank" rel="noreferrer">Открыть чат в Telegram</a>
        <SupportLockButton api={api} user={user} onDone={onDone} />
      </div>
    </Modal>
  );
}
