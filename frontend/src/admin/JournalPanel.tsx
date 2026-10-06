import { useCallback, useEffect, useState } from 'react';
import type { AdminAuditItem } from '../../../shared/api';
import { AUDIT_GROUPS } from '../../../shared/audit';
import type { AdminApi } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { eventText } from './DealDetail';
import { ACTOR } from './ui';

const dayStart = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : undefined);
const dayEnd = (v: string) => (v ? new Date(`${v}T23:59:59`).getTime() : undefined);

/** Every financial and administrative event, with filters. */
export function JournalPanel({ api, userId, onClearUser, onOpenDeal, onOpenUser }: {
  api: AdminApi;
  userId: number | null;
  onClearUser: () => void;
  onOpenDeal: (id: number) => void;
  onOpenUser: (id: number) => void;
}) {
  const [groups, setGroups] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [deal, setDeal] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AdminAuditItem[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(
    (before?: number) => ({
      types: AUDIT_GROUPS.filter((g) => groups.includes(g.id)).flatMap((g) => g.types).join(','),
      q,
      dealId: deal ? Number(deal.replace(/\D/g, '')) : undefined,
      userId: userId ?? undefined,
      from: dayStart(from),
      to: dayEnd(to),
      before,
    }),
    [groups, q, deal, userId, from, to],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      api.journal(query()).then((r) => { setItems(r.items); setMore(r.items.length === 100); setError(null); }, (e) => setError((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
  }, [api, query]);

  const toggle = (id: string) => setGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  return (
    <div className="ab-page">
      <div className="ab-chips">
        {AUDIT_GROUPS.map((g) => (
          <button key={g.id} className={`ab-fchip ${groups.includes(g.id) ? 'on' : ''}`} onClick={() => toggle(g.id)}>{g.label}</button>
        ))}
        {userId && <button className="ab-fchip on" onClick={onClearUser}>Пользователь #{userId} ✕</button>}
      </div>
      <div className="ab-filters">
        <input className="ab-search" placeholder="Поиск: @username, имя, текст" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="ab-small-input" placeholder="№ сделки" inputMode="numeric" value={deal} onChange={(e) => setDeal(e.target.value)} />
        <label className="ab-date">с <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="ab-date">по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {error && <div className="adm-error">{error}</div>}
      {items.length === 0 && <div className="adm-empty">Событий нет</div>}
      <div className="ab-journal">
        {items.map((e) => (
          <div key={e.id} className={`ab-jrow actor-${e.actor}`}>
            <span className="adm-muted small">{fmtDateTime(e.at)}</span>
            <span className="ab-jactor">{ACTOR[e.actor]}</span>
            <span className="ab-jtext">{eventText(e)}</span>
            <span className="ab-jlinks">
              {e.withdrawalId && <button className="adm-link" onClick={() => onOpenDeal(e.withdrawalId!)}>№{e.withdrawalId}</button>}
              {e.userId && <button className="adm-link" onClick={() => onOpenUser(e.userId!)}>{e.username ? `@${e.username}` : e.firstName ?? `#${e.userId}`}</button>}
            </span>
          </div>
        ))}
      </div>
      {more && (
        <button className="adm-btn" onClick={() => api.journal(query(items.at(-1)!.id)).then((r) => { setItems((x) => [...x, ...r.items]); setMore(r.items.length === 100); })}>
          Показать ещё
        </button>
      )}
    </div>
  );
}
