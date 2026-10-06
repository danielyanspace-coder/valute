import { useCallback, useEffect, useState } from 'react';
import type { AdminObligationDto, AdminUserListItem } from '../../../shared/api';
import type { AdminApi } from '../lib/api';
import { fmtDateTime, fmtMicroExact } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { ConfirmDialog, Modal, type ConfirmRequest } from './ui';

const DEFAULT_REASON = 'в предыдущей сделке вам было перечислено больше необходимой суммы';
const STATUS_LABEL = { active: 'Активна', repaid: 'Погашена', written_off: 'Списана' } as const;
const TABS = [
  { id: 'active', label: 'Активные' },
  { id: 'repaid', label: 'Погашенные' },
  { id: 'written_off', label: 'Списанные' },
  { id: '', label: 'Все' },
];

/** Shadow holds: the user never sees them until money is actually held back. */
export function ObligationsPanel({ api, onOpenUser, onOpenDeal }: { api: AdminApi; onOpenUser: (id: number) => void; onOpenDeal: (id: number) => void }) {
  const [status, setStatus] = useState('active');
  const [items, setItems] = useState<AdminObligationDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.obligations({ status }).then((r) => { setItems(r.items); setError(null); }, (e) => setError((e as Error).message));
  }, [api, status]);
  usePolling(load, 10_000);
  useEffect(load, [load]);

  return (
    <div className="ab-page">
      <div className="ab-page-head">
        <nav className="adm-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`adm-tab ${status === t.id ? 'active' : ''}`} onClick={() => setStatus(t.id)}>{t.label}</button>
          ))}
        </nav>
        <button className="adm-btn primary" onClick={() => setCreating(true)}>Создать теневую заморозку</button>
      </div>
      <p className="adm-muted small">Пользователь не видит теневые заморозки. Удержание происходит автоматически из доступного баланса, при каждом поступлении, и только тогда бот присылает уведомление.</p>
      {error && <div className="adm-error">{error}</div>}
      {items.length === 0 && <div className="adm-empty">Нет записей</div>}
      <div className="ab-list">
        {items.map((o) => (
          <ObligationRow key={o.id} o={o} api={api} onChanged={load} onOpenUser={onOpenUser} onOpenDeal={onOpenDeal} />
        ))}
      </div>
      {creating && <ObligationForm api={api} onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}

function ObligationRow({ o, api, onChanged, onOpenUser, onOpenDeal }: { o: AdminObligationDto; api: AdminApi; onChanged: () => void; onOpenUser: (id: number) => void; onOpenDeal: (id: number) => void }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const pct = Math.round((o.repaidMicro / o.amountMicro) * 100);
  return (
    <div className={`ab-ob s-${o.status}`}>
      <div className="ab-ob-top">
        <b>#{o.id} · {fmtMicroExact(o.amountMicro)}</b>
        <span className={`ab-chip ob-${o.status}`}>{STATUS_LABEL[o.status]}</span>
      </div>
      <div className="ab-progress"><span style={{ width: `${pct}%` }} /></div>
      <div className="ab-ob-grid">
        <span className="adm-k">Удержано</span><span>{fmtMicroExact(o.repaidMicro)} ({pct}%)</span>
        <span className="adm-k">Пользователь</span>
        <button className="adm-link" onClick={() => onOpenUser(o.user.id)}>{o.user.username ? `@${o.user.username}` : o.user.firstName}</button>
        <span className="adm-k">Причина для пользователя</span><span>{o.publicReason}</span>
        <span className="adm-k">Комментарий</span><span>{o.comment ?? 'Нет'}</span>
        <span className="adm-k">Создана</span><span>{fmtDateTime(o.createdAt)}</span>
        {o.withdrawalId && (<><span className="adm-k">Сделка</span><button className="adm-link" onClick={() => onOpenDeal(o.withdrawalId!)}>№{o.withdrawalId}</button></>)}
        {o.repaidAt && (<><span className="adm-k">Погашена полностью</span><span>{fmtDateTime(o.repaidAt)}</span></>)}
        {o.writtenOffAt && (<><span className="adm-k">Списана</span><span>{fmtDateTime(o.writtenOffAt)} · {o.writeOffComment}</span></>)}
      </div>
      {o.repayments.length > 0 && (
        <div className="ab-ob-holds">
          {o.repayments.map((r, i) => (
            <span key={i}>{fmtDateTime(r.at)}: −{fmtMicroExact(r.amountMicro)}</span>
          ))}
        </div>
      )}
      {o.status === 'active' && (
        <button
          className="adm-btn small danger-ghost"
          onClick={() =>
            setConfirm({
              title: `Списать теневую заморозку #${o.id}?`,
              text: `Оставшиеся ${fmtMicroExact(o.amountMicro - o.repaidMicro)} больше не будут удерживаться.`,
              confirmLabel: 'Списать',
              tone: 'danger',
              reasonLabel: 'Причина списания',
              run: async (i) => {
                await api.writeOffObligation(o.id, i.reason || 'списано администратором');
                onChanged();
              },
            })
          }
        >
          Списать (простить)
        </button>
      )}
      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** Create form: pick a user (unless preset), amount in USDT, reason shown on hold, internal comment. */
export function ObligationForm({ api, preset, onClose, onDone }: {
  api: AdminApi;
  preset?: { userId: number; label: string; withdrawalId?: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<AdminUserListItem[]>([]);
  const [user, setUser] = useState<{ id: number; label: string } | null>(preset ? { id: preset.userId, label: preset.label } : null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [comment, setComment] = useState('');
  const [deal, setDeal] = useState(preset?.withdrawalId ? String(preset.withdrawalId) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user || query.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api.users(query).then((r) => setFound(r.items.slice(0, 8)), () => {}), 250);
    return () => clearTimeout(t);
  }, [api, query, user]);

  const submit = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api.createObligation({
        userId: user.id,
        amountUsdt: Number(amount.replace(',', '.')),
        publicReason: reason,
        comment,
        withdrawalId: deal ? Number(deal.replace(/\D/g, '')) : null,
      });
      onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Теневая заморозка" onClose={onClose}>
      <p className="adm-muted small">Если у пользователя есть доступные USDT, сумма удержится сразу. Остаток удержится автоматически из будущих поступлений.</p>
      {user ? (
        <div className="ab-picked">
          Пользователь: <b>{user.label}</b>
          {!preset && <button className="adm-link" onClick={() => setUser(null)}>Изменить</button>}
        </div>
      ) : (
        <label className="adm-field">
          <span>Пользователь</span>
          <input autoFocus placeholder="@username, имя или Telegram ID" value={query} onChange={(e) => setQuery(e.target.value)} />
          {found.map((u) => (
            <button key={u.id} className="ab-found" onClick={() => setUser({ id: u.id, label: u.username ? `@${u.username}` : u.firstName })}>
              {u.username ? `@${u.username}` : u.firstName} <span className="adm-muted">· ID {u.telegramId} · {fmtMicroExact(u.availableMicro)}</span>
            </button>
          ))}
        </label>
      )}
      <label className="adm-field">
        <span>Сумма, USDT</span>
        <input inputMode="decimal" placeholder="Например, 12.5" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="adm-field">
        <span>Причина в уведомлении пользователю</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="adm-field">
        <span>Комментарий для себя</span>
        <input placeholder="Например, переплата 1000 ₽ по сделке" value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <label className="adm-field">
        <span>Связанная сделка (номер)</span>
        <input inputMode="numeric" placeholder="Необязательно" value={deal} onChange={(e) => setDeal(e.target.value)} />
      </label>
      {error && <div className="adm-error">{error}</div>}
      <div className="ab-modal-actions">
        <button className="adm-btn ghost-lg" onClick={onClose}>Отмена</button>
        <button className="adm-btn primary big" disabled={busy || !user || !amount} onClick={submit}>Создать</button>
      </div>
    </Modal>
  );
}
