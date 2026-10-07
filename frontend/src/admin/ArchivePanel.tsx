import { useCallback, useEffect, useState } from 'react';
import type { AdminWithdrawalListItem, ArchiveQuery } from '../../../shared/api';
import { RESOLUTION_LABEL, type DealResolution } from '../../../shared/deals';
import type { AdminApi } from '../lib/api';
import { fmtDateTime, fmtRub0 } from '../lib/format';
import { PayoutLogo } from './ui';

const RESOLUTIONS = Object.entries(RESOLUTION_LABEL) as [DealResolution, string][];
const dayStart = (v: string) => (v ? new Date(`${v}T00:00:00`).getTime() : undefined);
const dayEnd = (v: string) => (v ? new Date(`${v}T23:59:59`).getTime() : undefined);

/** Finished deals: one search box (number, your ID, @username, amount, phone/card) plus filters. */
export function ArchivePanel({ api, onOpenDeal }: { api: AdminApi; onOpenDeal: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [resolution, setResolution] = useState<DealResolution | ''>('');
  const [method, setMethod] = useState<'' | 'sbp' | 'card'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AdminWithdrawalListItem[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback((offset: number): ArchiveQuery => ({ q, resolution, method, from: dayStart(from), to: dayEnd(to), offset }), [q, resolution, method, from, to]);

  useEffect(() => {
    const t = setTimeout(() => {
      api.archive(query(0)).then((r) => { setItems(r.items); setMore(r.items.length === 100); setError(null); }, (e) => setError((e as Error).message));
    }, 250);
    return () => clearTimeout(t);
  }, [api, query]);

  return (
    <div className="ab-page">
      <div className="ab-filters">
        <input className="ab-search" placeholder="Номер, ваш ID, @username, сумма, телефон или карта" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={resolution} onChange={(e) => setResolution(e.target.value as DealResolution | '')}>
          <option value="">Все исходы</option>
          {RESOLUTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value as '' | 'sbp' | 'card')}>
          <option value="">СБП и карты</option>
          <option value="sbp">СБП</option>
          <option value="card">Карта</option>
        </select>
        <div className="ab-dates">
          <label className="ab-date">с <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="ab-date">по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </div>
      {error && <div className="adm-error">{error}</div>}
      {items.length === 0 && <div className="adm-empty">Ничего не найдено</div>}
      <div className="ab-table">
        {items.map((d) => (
          <button key={d.id} className="ab-trow" onClick={() => onOpenDeal(d.id)}>
            <span className="ab-tno">№{d.id}{d.externalId && <small>{d.externalId}</small>}</span>
            <span className="ab-tamount">{fmtRub0(d.finalRub ?? d.amountRub)}{d.finalRub !== null && d.finalRub !== d.amountRub && <small>из {fmtRub0(d.amountRub)}</small>}</span>
            <span className="ab-tdest"><PayoutLogo method={d.method} bankId={d.bankId} destination={d.destination} size={20} /> {d.destination}</span>
            <span className="ab-tuser">{d.user.username ? `@${d.user.username}` : d.user.firstName}</span>
            <span className={`ab-chip r-${d.resolution}`}>{d.resolution ? RESOLUTION_LABEL[d.resolution] : ''}</span>
            <span className="adm-muted small">{d.finishedAt ? fmtDateTime(d.finishedAt) : ''}</span>
          </button>
        ))}
      </div>
      {more && (
        <button className="adm-btn" onClick={() => api.archive(query(items.length)).then((r) => { setItems((x) => [...x, ...r.items]); setMore(r.items.length === 100); })}>
          Показать ещё
        </button>
      )}
    </div>
  );
}
