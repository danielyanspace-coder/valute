import { useCallback, useEffect, useState } from 'react';
import type { AdminUserListItem, AdminUserPageDto } from '../../../shared/api';
import { ADMIN_STATUS_LABEL } from '../../../shared/deals';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtMicroExact, fmtRub0 } from '../lib/format';
import { ObligationForm } from './ObligationsPanel';
import { Card, Row, UserCard, tgLink } from './ui';

/** Users: search, then the full profile with the support lock, holds and every deal. */
export function UsersPanel({ api, userId, onOpenUser, onOpenDeal, onOpenJournal }: {
  api: AdminApi;
  userId: number | null;
  onOpenUser: (id: number | null) => void;
  onOpenDeal: (id: number) => void;
  onOpenJournal: (userId: number) => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<AdminUserListItem[]>([]);
  useEffect(() => {
    if (userId) return;
    const t = setTimeout(() => api.users(q).then((r) => setItems(r.items), () => {}), 250);
    return () => clearTimeout(t);
  }, [api, q, userId]);

  if (userId) return <UserPage api={api} id={userId} onBack={() => onOpenUser(null)} onOpenDeal={onOpenDeal} onOpenJournal={onOpenJournal} />;

  return (
    <div className="ab-page">
      <input className="ab-search" placeholder="@username, имя, Telegram ID" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="ab-table">
        {items.map((u) => (
          <button key={u.id} className="ab-trow user" onClick={() => onOpenUser(u.id)}>
            <span className="ab-tno">{u.username ? `@${u.username}` : u.firstName}<small>ID {u.id} · TG {u.telegramId}</small></span>
            <span>{fmtMicroExact(u.availableMicro)}<small>заморожено {fmtMicroExact(u.frozenMicro)}</small></span>
            <span>{u.activeDeals ? `Активных сделок: ${u.activeDeals}` : 'Нет активных сделок'}</span>
            <span className="ab-flags">
              {u.supportLocked && <span className="ab-flag">Заблокирован до связи</span>}
              {u.blocked && <span className="ab-flag">Вывод запрещён</span>}
              {u.obligationsLeftMicro > 0 && <span className="ab-flag warn">Тень {fmtMicroExact(u.obligationsLeftMicro)}</span>}
            </span>
            <span className="adm-muted small">был {fmtAgo(u.lastSeenAt)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function UserPage({ api, id, onBack, onOpenDeal, onOpenJournal }: { api: AdminApi; id: number; onBack: () => void; onOpenDeal: (id: number) => void; onOpenJournal: (userId: number) => void }) {
  const [u, setU] = useState<AdminUserPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.user(id).then(setU, (e) => setError((e as Error).message)), [api, id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!u) return <div className="adm-empty">{error ?? 'Загружаем…'}</div>;
  const label = u.username ? `@${u.username}` : u.firstName;
  return (
    <div className="ab-page">
      <div className="ab-page-head">
        <button className="adm-link" onClick={onBack}>← Все пользователи</button>
        <div className="adm-actions">
          <a className="adm-btn contact" href={tgLink(u)} target="_blank" rel="noreferrer">Чат в Telegram</a>
          <button className="adm-btn" onClick={() => onOpenJournal(u.id)}>Журнал пользователя</button>
          <button className="adm-btn" onClick={() => setCreating(true)}>Теневая заморозка</button>
        </div>
      </div>
      <h2 className="ab-h">{label} {u.lastName ?? ''}</h2>
      <div className="adm-grid">
        <UserCard u={u} api={api} onDone={load} />
        <Card title="Статистика">
          <Row k="Пополнено" v={fmtMicroExact(u.stats.depositedMicro)} />
          <Row k="Выведено" v={`${fmtRub0(u.stats.withdrawnRub)} · ${fmtMicroExact(u.stats.withdrawnMicro)}`} />
          <Row k="Сделок всего" v={`${u.stats.withdrawalsTotal}, выполнено ${u.stats.withdrawalsCompleted}`} />
          <Row k="Сообщал «не поступила»" v={String(u.stats.disputes)} tone={u.stats.disputes ? 'warn' : undefined} />
          <Row k="Переводы" v={`получено ${fmtMicroExact(u.stats.transfersInMicro)}, отправлено ${fmtMicroExact(u.stats.transfersOutMicro)}`} />
          {u.senderWallets.map((a) => <Row key={a.address} k={`Пополнял с кошелька · ${a.deposits}`} v={a.address} copy={a.address} mono small />)}
        </Card>
        <Card title="Теневые заморозки">
          {u.obligations.length === 0 && <div className="adm-muted small">Нет</div>}
          {u.obligations.map((o) => (
            <Row key={o.id} k={`#${o.id} · ${fmtDateTime(o.createdAt)}`} v={`${fmtMicroExact(o.repaidMicro)} из ${fmtMicroExact(o.amountMicro)}`} sub={o.comment ?? o.publicReason} tone={o.status === 'active' ? 'warn' : undefined} />
          ))}
        </Card>
      </div>
      <Card title={`Сделки (${u.deals.length})`}>
        {u.deals.length === 0 && <div className="adm-muted small">Сделок нет</div>}
        {u.deals.map((d) => (
          <button key={d.id} className="ab-mini" onClick={() => onOpenDeal(d.id)}>
            <span>№{d.id}</span>
            <span>{fmtRub0(d.finalRub ?? d.amountRub)}</span>
            <span className={`ab-chip s-${d.section ?? d.status}`}>{ADMIN_STATUS_LABEL[d.status]}</span>
            <span className="adm-muted">{fmtDateTime(d.createdAt)}</span>
          </button>
        ))}
      </Card>
      {creating && <ObligationForm api={api} preset={{ userId: u.id, label }} onClose={() => setCreating(false)} onDone={load} />}
    </div>
  );
}
