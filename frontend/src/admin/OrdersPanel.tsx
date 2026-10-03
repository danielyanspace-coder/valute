import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AdminOrderCounts, AdminOrderDto, AdminOrderListItem, WithdrawalEventDto } from '../../../shared/api';
import { ORDER_STATUS_LABEL, SERVICE_TITLE, formatParkingPhone, isOrderFinal, type OrderStatus } from '../../../shared/services';
import { SERVICE_LOGO } from '../components/services/ServiceFlows';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtMicro, fmtMicroExact, fmtRub, fmtRub0, fmtTime } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { ACTOR, Adjust, Card, ContactClient, Row, TwoStep, UserCard } from './AdminApp';

type Filter = OrderStatus | 'all';

const TABS: { id: Filter; label: string }[] = [
  { id: 'pending', label: 'Новые' },
  { id: 'clarify', label: 'Требуется уточнение' },
  { id: 'paid', label: 'Оплачено' },
  { id: 'rejected', label: 'Отклонено' },
  { id: 'all', label: 'Все' },
];

/** "МК": fines, parking and Steam orders the operator fulfils by hand. */
export function OrdersPanel({ api, top }: { api: AdminApi; top: ReactNode }) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [items, setItems] = useState<AdminOrderListItem[]>([]);
  const [counts, setCounts] = useState<AdminOrderCounts | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.orders(filter).then(
      (r) => {
        setItems(r.items);
        setCounts(r.counts);
        setLoadError(null);
      },
      (e) => setLoadError((e as Error).message),
    );
  }, [api, filter]);
  usePolling(load, 5000);
  useEffect(load, [load]);

  return (
    <div className="adm">
      {top}
      <nav className="adm-tabs">
        {TABS.map((t) => {
          const n = t.id === 'all' || !counts ? null : counts[t.id];
          return (
            <button key={t.id} className={`adm-tab ${filter === t.id ? 'active' : ''}`} onClick={() => { setFilter(t.id); setSelected(null); setItems([]); }}>
              {t.label}
              {n !== null && n > 0 && <span className={`adm-count ${t.id === 'pending' || t.id === 'clarify' ? 'hot' : ''}`}>{n}</span>}
            </button>
          );
        })}
      </nav>
      {loadError && <div className="adm-error">{loadError}</div>}
      <div className={`adm-body ${selected ? 'has-detail' : ''}`}>
        <section className="adm-list">
          {items.length === 0 && <div className="adm-empty">Заявок нет</div>}
          {items.map((o) => (
            <button key={o.id} className={`adm-row ${selected === o.id ? 'active' : ''}`} onClick={() => setSelected(o.id)}>
              <div className="adm-row-top">
                <span className="adm-row-id">МК-{o.id}</span>
                <OrderChip status={o.status} />
                <span className="adm-row-time">{fmtAgo(o.createdAt)}</span>
              </div>
              <div className="adm-row-main">
                <img className={`adm-svc-logo k-${o.kind}`} src={SERVICE_LOGO[o.kind]} alt="" />
                <div className="adm-row-text">
                  <div className="adm-row-amount">{fmtRub0(o.amountRub)}</div>
                  <div className="adm-row-sub">{SERVICE_TITLE[o.kind]} · {o.target}</div>
                </div>
              </div>
              <div className="adm-row-sub">
                {o.user.username ? `@${o.user.username}` : <span className="adm-warn-text">username скрыт</span>} · {o.user.firstName}
              </div>
            </button>
          ))}
        </section>
        <section className="adm-detail">
          {selected ? <OrderDetail key={selected} api={api} id={selected} onBack={() => setSelected(null)} onChanged={load} /> : <div className="adm-empty">Выберите заявку слева</div>}
        </section>
      </div>
    </div>
  );
}

function OrderDetail({ api, id, onBack, onChanged }: { api: AdminApi; id: number; onBack: () => void; onChanged: () => void }) {
  const [d, setD] = useState<AdminOrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'none' | 'clarify' | 'reject'>('none');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    api.orderGet(id).then(setD, (e) => setError((e as Error).message));
  }, [api, id]);
  usePolling(load, 4000);

  const act = async (fn: () => Promise<AdminOrderDto>) => {
    setBusy(true);
    setError(null);
    try {
      setD(await fn());
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <div className="adm-empty">{error ?? 'Загружаем…'}</div>;
  const u = d.userDetails;

  return (
    <div className="adm-d">
      <button className="adm-link adm-back" onClick={onBack}>← К списку</button>

      <div className="adm-card adm-d-head">
        <div className="adm-d-title">
          <img className={`adm-svc-logo k-${d.kind}`} src={SERVICE_LOGO[d.kind]} alt="" />
          <span>МК-{d.id} · {SERVICE_TITLE[d.kind]}</span>
          <OrderChip status={d.status} />
        </div>
        <div className="adm-d-amount">{fmtRub0(d.amountRub)}</div>
        <div className="adm-muted">
          Пользователь заплатил {fmtMicroExact(d.amountMicro)} по курсу {fmtRub(d.rate)} (Rapira {fmtRub(d.exchangeRate)}, скидка {d.discountPercent}%)
        </div>
        <div className="adm-muted">Выгода клиента {fmtRub0(d.benefitRub)} · создана {fmtDateTime(d.createdAt)} ({fmtAgo(d.createdAt)})</div>
      </div>

      {d.status === 'clarify' && <div className="adm-banner info">Ждём ответа клиента. Вопрос: «{d.clarifyMessage}»</div>}
      {d.status === 'rejected' && <div className="adm-banner">Отклонена: {d.rejectReason}</div>}
      {d.status === 'paid' && <div className="adm-banner ok">Оплачено {fmtDateTime(d.finishedAt!)}</div>}

      <div className="adm-actions">
        <ContactClient user={u} />
        {!isOrderFinal(d.status) && (
          <>
            <TwoStep
              label="Оплачено"
              confirm={`Точно оплатили ${fmtRub0(d.amountRub)}? USDT спишутся с клиента окончательно.`}
              tone="success"
              busy={busy}
              onConfirm={() => act(() => api.orderPaid(d.id))}
            />
            <button className="adm-btn warn" disabled={busy} onClick={() => { setMode('clarify'); setText(''); }}>Требуется уточнение</button>
            <button className="adm-btn danger-ghost" disabled={busy} onClick={() => { setMode('reject'); setText(''); }}>Отклонено</button>
          </>
        )}
      </div>
      {mode !== 'none' && !isOrderFinal(d.status) && (
        <div className="adm-inline">
          <input
            id="order-text"
            placeholder={mode === 'clarify' ? 'Что уточнить? Клиент увидит этот текст' : 'Причина, её увидит клиент'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className={`adm-btn ${mode === 'reject' ? 'danger' : 'warn'}`}
            disabled={busy || !text.trim()}
            onClick={async () => {
              const ok = await act(() => (mode === 'clarify' ? api.orderClarify(d.id, text) : api.orderReject(d.id, text)));
              if (ok) setMode('none');
            }}
          >
            {mode === 'clarify' ? 'Отправить вопрос' : 'Отклонить и вернуть USDT'}
          </button>
          <button className="adm-link" onClick={() => setMode('none')}>Отмена</button>
        </div>
      )}
      {error && <div className="adm-error">{error}</div>}

      <div className="adm-grid">
        <Card title="Что оплатить">
          {d.kind === 'fine' && (
            <>
              <Row k="УИН" v={d.fine?.uin ?? d.target.replace('УИН ', '')} copy={d.fine?.uin ?? d.target.replace('УИН ', '')} mono big />
              <Row k="Сумма к оплате" v={fmtRub0(d.amountRub)} copy={String(d.amountRub)} big />
              <Row
                k="Источник суммы"
                v={d.amountSource === 'provider' ? 'Найдена по УИН' : 'Ввёл клиент, проверьте по УИН'}
                tone={d.amountSource === 'provider' ? 'ok' : 'warn'}
              />
              {d.fine?.description && <Row k="Нарушение" v={d.fine.description} />}
              {d.fine?.article && <Row k="Статья" v={d.fine.article} />}
              {d.fine && <Row k="Полная сумма" v={fmtRub0(d.fine.amountRub)} />}
              {d.fine?.discountedAmountRub && <Row k="Со скидкой 50%" v={`${fmtRub0(d.fine.discountedAmountRub)} до ${new Date(d.fine.discountUntil!).toLocaleDateString('ru-RU')}`} />}
            </>
          )}
          {d.kind === 'parking' && (
            <>
              <Row k="Телефон аккаунта" v={formatParkingPhone(d.phone ?? '')} copy={`+${d.phone}`} big />
              <Row k="Сумма пополнения" v={fmtRub0(d.amountRub)} copy={String(d.amountRub)} big />
              <Row k="Сервис" v="Парковки России" />
            </>
          )}
          {d.kind === 'steam' && (
            <>
              <Row k="Логин Steam" v={d.steamLogin ?? ''} copy={d.steamLogin ?? ''} mono big />
              <Row k="Сумма на Steam" v={fmtRub0(d.amountRub)} copy={String(d.amountRub)} big />
              <Row k="Требования" v="Валюта рубли, регион Россия/СНГ" />
            </>
          )}
        </Card>

        <UserCard u={u} api={api} onDone={load} />

        <Card title="Баланс">
          <Row k="Доступно сейчас" v={fmtMicroExact(u.availableMicro)} big />
          <Row k="Заморожено" v={fmtMicroExact(u.frozenMicro)} />
          <Row k="Баланс до заявки" v={fmtMicroExact(d.balanceBeforeMicro)} />
          <Row k="Всего пополнено" v={fmtMicro(u.stats.depositedMicro)} />
          <Row k="Выводов" v={`${u.stats.withdrawalsTotal}, выполнено ${u.stats.withdrawalsCompleted}`} />
          <Adjust api={api} userId={u.id} onDone={load} />
        </Card>

        <Card title="Проверка">
          <Row k="IP" v={d.clientIp ?? 'Нет данных'} copy={d.clientIp ?? undefined} />
          <Row k="Платформа" v={d.platform ?? 'Нет данных'} />
        </Card>
      </div>

      <Card title="История заявки">
        <ol className="adm-timeline">
          {d.events.map((e) => (
            <li key={e.id} className={`actor-${e.actor}`}>
              <span className="adm-tl-time">{fmtDateTime(e.at)}</span>
              <span className="adm-tl-actor">{ACTOR[e.actor]}</span>
              <span className="adm-tl-text">{orderEventText(e)}</span>
            </li>
          ))}
        </ol>
        <div className="adm-inline">
          <input id="order-note" placeholder="Заметка для истории, видна только админам" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="adm-btn" disabled={busy || !note.trim()} onClick={async () => (await act(() => api.orderNote(d.id, note))) && setNote('')}>
            Добавить
          </button>
        </div>
      </Card>
    </div>
  );
}

function orderEventText(e: WithdrawalEventDto): string {
  const x = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'created':
      return `Создал заявку на ${fmtRub0(Number(x.amountRub))}, заморожено ${fmtMicroExact(Number(x.amountMicro))} по курсу ${fmtRub(Number(x.rate))}`;
    case 'paid':
      return 'Отметил заявку оплаченной, USDT списаны';
    case 'clarify':
      return `Запросил уточнение: «${x.message}»`;
    case 'rejected':
      return `Отклонил заявку, USDT возвращены. Причина: ${x.reason}`;
    case 'note':
      return `Заметка: ${x.text}`;
    default:
      return `${e.type} ${fmtTime(e.at)}`;
  }
}

function OrderChip({ status }: { status: OrderStatus }) {
  return <span className={`adm-chip o-${status}`}>{ORDER_STATUS_LABEL[status]}</span>;
}
