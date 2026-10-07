import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AdminDepositCounts, AdminDepositDto, AdminUserRef } from '../../../shared/api';
import { DEPOSIT_REVIEW_TEXT } from '../../../shared/deposits';
import type { AdminApi } from '../lib/api';
import { DepositPool } from './DepositPool';
import { fmtAgo, fmtDateTime, fmtMicroExact } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { Card, ContactClient, Row, TwoStep } from './ui';

type Filter = keyof AdminDepositCounts | 'all' | 'pool';

const TABS: { id: Filter; label: string }[] = [
  { id: 'held', label: 'На проверке' },
  { id: 'below_min', label: 'Меньше минимума' },
  { id: 'pending', label: 'Подтверждаются' },
  { id: 'credited', label: 'Зачислены' },
  { id: 'rejected', label: 'Отклонены' },
  { id: 'all', label: 'Все' },
  { id: 'pool', label: 'Адреса' },
];

const who = (u: AdminUserRef) => (u.username ? `@${u.username}` : `${u.firstName} (ID ${u.id})`);

const STATUS: Record<AdminDepositDto['status'], { label: string; bg: string; fg: string }> = {
  held: { label: 'На проверке', bg: 'rgba(255, 93, 108, 0.14)', fg: '#ff8d98' },
  below_min: { label: 'Меньше минимума', bg: 'rgba(255, 190, 80, 0.14)', fg: '#ffc768' },
  pending: { label: 'Подтверждается', bg: 'rgba(127, 140, 255, 0.15)', fg: '#b8c0ff' },
  credited: { label: 'Зачислено', bg: 'rgba(47, 209, 139, 0.14)', fg: '#2fd18b' },
  rejected: { label: 'Отклонено', bg: 'rgba(139, 147, 163, 0.15)', fg: '#b3bac7' },
  failed: { label: 'Не прошло', bg: 'rgba(139, 147, 163, 0.15)', fg: '#b3bac7' },
};

const AML_SOURCE: Record<string, string> = {
  tether_blacklist: 'Чёрный список Tether',
  ofac_sdn: 'Санкции OFAC',
  chainalysis_sanctions: 'Chainalysis',
};

const tronscan = (kind: 'transaction' | 'address', id: string) => `https://tronscan.org/#/${kind}/${id}`;
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

function Chip({ status }: { status: AdminDepositDto['status'] }) {
  const s = STATUS[status];
  return <span className="adm-chip" style={{ background: s.bg, color: s.fg }}>{s.label}</span>;
}

/** Incoming USDT TRC-20: what was credited automatically and what waits for a decision. */
export function DepositsPanel({ api, top }: { api: AdminApi; top: ReactNode }) {
  const [filter, setFilter] = useState<Filter>('held');
  const [items, setItems] = useState<AdminDepositDto[]>([]);
  const [counts, setCounts] = useState<AdminDepositCounts | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (filter === 'pool') return;
    api.deposits(filter).then(
      (r) => {
        setItems(r.items);
        setCounts(r.counts);
        setEnabled(r.enabled);
        setLoadError(null);
      },
      (e) => setLoadError((e as Error).message),
    );
  }, [api, filter]);
  usePolling(load, 5000);
  useEffect(load, [load]);

  const current = items.find((d) => d.id === selected) ?? null;

  return (
    <div className="adm">
      {top}
      <nav className="adm-tabs">
        {TABS.map((t) => {
          const n = t.id === 'all' || t.id === 'pool' || !counts ? null : counts[t.id];
          return (
            <button key={t.id} className={`adm-tab ${filter === t.id ? 'active' : ''}`} onClick={() => { setFilter(t.id); setSelected(null); setItems([]); }}>
              {t.label}
              {n !== null && n > 0 && <span className={`adm-count ${t.id === 'held' || t.id === 'below_min' ? 'hot' : ''}`}>{n}</span>}
            </button>
          );
        })}
      </nav>
      {!enabled && filter !== 'pool' && (
        <div className="adm-banner info" style={{ marginTop: 12 }}>
          Пополнения выключены: нет ни одного включённого адреса. Добавьте адреса во вкладке «Адреса».
        </div>
      )}
      {loadError && <div className="adm-error">{loadError}</div>}
      {filter === 'pool' ? <DepositPool api={api} /> : (
      <div className={`adm-body ${current ? 'has-detail' : ''}`}>
        <section className="adm-list">
          {items.length === 0 && <div className="adm-empty">Пополнений нет</div>}
          {items.map((d) => (
            <button key={d.id} className={`adm-row ${selected === d.id ? 'active' : ''}`} onClick={() => setSelected(d.id)}>
              <div className="adm-row-top">
                <span className="adm-row-id">П-{d.id}</span>
                <Chip status={d.status} />
                <span className="adm-row-time">{fmtAgo(d.createdAt)}</span>
              </div>
              <div className="adm-row-amount">+{fmtMicroExact(d.amountMicro)}</div>
              <div className="adm-row-sub">
                {d.user ? who(d.user) : 'Не определён'} · от {d.fromAddress ? short(d.fromAddress) : 'неизвестно'}
              </div>
              {d.status === 'held' && d.review && d.review !== 'aml' && <div className="adm-row-sub adm-warn-text">{DEPOSIT_REVIEW_TEXT[d.review]}</div>}
              {d.amlDecision === 'reject' && <div className="adm-row-sub adm-warn-text">AML: адрес отправителя в чёрном списке</div>}
              {d.late && <div className="adm-row-sub">Пришло после окончания заявки</div>}
            </button>
          ))}
        </section>
        <section className="adm-detail">
          {current ? <DepositDetail key={current.id} api={api} d={current} onBack={() => setSelected(null)} onChanged={load} /> : <div className="adm-empty">Выберите пополнение слева</div>}
        </section>
      </div>
      )}
    </div>
  );
}

function DepositDetail({ api, d, onBack, onChanged }: { api: AdminApi; d: AdminDepositDto; onBack: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const open = d.status === 'held' || d.status === 'below_min';
  // Who the money can go to: the current owner, the address holder, and accounts this wallet topped up.
  const candidates = [d.user, d.issuedTo, ...d.senderUsers].filter((u, i, all): u is AdminUserRef => !!u && all.findIndex((x) => x?.id === u.id) === i);
  const [target, setTarget] = useState<string>(candidates[0] ? String(candidates[0].id) : '');
  const targetId = Number(target) || 0;
  const targetUser = candidates.find((u) => u.id === targetId);

  const act = async (fn: () => Promise<AdminDepositDto>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const senders = d.senderUsers.map(who).join(', ');

  return (
    <div className="adm-d">
      <button className="adm-link adm-back" onClick={onBack}>← К списку</button>

      <div className="adm-card adm-d-head">
        <div className="adm-d-title">
          <span>П-{d.id} · USDT TRC-20</span>
          <Chip status={d.status} />
        </div>
        <div className="adm-d-amount">+{fmtMicroExact(d.amountMicro)}</div>
        <div className="adm-muted">Отправлено {fmtDateTime(d.createdAt)} ({fmtAgo(d.createdAt)})</div>
      </div>

      {d.status === 'held' && d.review === 'aml' && d.amlDecision === 'reject' && (
        <div className="adm-banner danger">
          <b>Адрес отправителя найден в чёрном списке.</b>
          <span>Не зачисляйте и не переводите эти USDT дальше: Tether может заморозить адрес. Свяжитесь с клиентом и выясните источник.</span>
        </div>
      )}
      {d.status === 'held' && d.review === 'aml' && d.amlDecision !== 'reject' && (
        <div className="adm-banner info">AML-проверка не смогла выполниться. Проверьте отправителя вручную (кнопка «Открыть в Tronscan») и решите.</div>
      )}
      {d.status === 'held' && d.review === 'unidentified' && (
        <div className="adm-banner info">
          <b>Неопознанный платёж.</b>
          <span>В момент перевода адрес ни за кем не был закреплён, и с этого кошелька раньше никто не пополнял{d.senderUsers.length > 1 ? ' (или пополняли несколько человек, это похоже на биржу)' : ''}. Дождитесь, пока клиент напишет в поддержку с хэшем, и зачислите ему.</span>
        </div>
      )}
      {d.status === 'held' && d.review === 'linked_sender' && (
        <div className="adm-banner info">
          <b>Связь с аккаунтом: {senders}.</b>
          <span>Адрес в этот момент никому не выдавался, но с этого кошелька раньше пополнял {senders}. Скорее всего, клиент отправил на старый адрес без заявки. Уточните у него и зачислите.</span>
        </div>
      )}
      {d.status === 'held' && d.review === 'sender_conflict' && (
        <div className="adm-banner info">
          <b>Адрес был выдан {d.issuedTo ? who(d.issuedTo) : 'другому клиенту'}, но кошелёк отправителя принадлежит {senders}.</b>
          <span>Возможно, один клиент отправил на адрес, который сейчас закреплён за другим, или это общий кошелёк. Свяжитесь с обоими и решите, кому зачислить.</span>
        </div>
      )}
      {d.status === 'below_min' && <div className="adm-banner info">Сумма меньше минимальной, поэтому не зачислена автоматически. Можно зачислить вручную.</div>}
      {d.status === 'credited' && (
        <div className="adm-banner ok">
          Зачислено {d.finishedAt ? fmtDateTime(d.finishedAt) : ''} {d.creditedBy === 'admin' ? 'вручную' : 'автоматически'}
          {d.user ? ` · ${who(d.user)}` : ''}
          {d.late ? '. Пришло после окончания заявки, во время карантина адреса' : ''}
        </div>
      )}
      {d.status === 'rejected' && <div className="adm-banner">Отклонено: {d.adminNote}</div>}

      {open && (
        <div className="adm-card dep-credit">
          <div className="adm-card-title">Кому зачислить</div>
          {candidates.length > 0 && (
            <div className="dep-cands">
              {candidates.map((u) => (
                <button key={u.id} className={`dep-cand ${targetId === u.id ? 'active' : ''}`} onClick={() => setTarget(String(u.id))}>
                  {who(u)}
                  <span>{u.id === d.issuedTo?.id ? 'получил этот адрес' : d.senderUsers.some((x) => x.id === u.id) ? 'пополнял с этого кошелька' : 'владелец'}</span>
                </button>
              ))}
            </div>
          )}
          <label className="dep-target">
            <span>ID пользователя</span>
            <input id="deposit-user" inputMode="numeric" placeholder="Например, 42" value={target} onChange={(e) => setTarget(e.target.value.replace(/\D/g, ''))} />
          </label>
          <div className="adm-muted small">ID есть в карточке пользователя в разделе «Пользователи».</div>
          <div className="adm-actions">
            <TwoStep
              label="Зачислить"
              confirm={`Зачислить ${fmtMicroExact(d.amountMicro)} ${targetUser ? who(targetUser) : `пользователю ID ${targetId}`}?`}
              tone="success"
              busy={busy || !targetId}
              onConfirm={() => act(() => api.depositCredit(d.id, d.status === 'below_min' ? 'меньше минимума, зачислено вручную' : 'проверено вручную', targetId))}
            />
            <button className="adm-btn danger-ghost" disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button>
          </div>
          {rejecting && (
            <div className="adm-inline">
              <input id="deposit-reason" placeholder="Причина, для истории" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="adm-btn danger" disabled={busy || !reason.trim()} onClick={async () => (await act(() => api.depositReject(d.id, reason))) && setRejecting(false)}>
                Отклонить
              </button>
              <button className="adm-link" onClick={() => setRejecting(false)}>Отмена</button>
            </div>
          )}
        </div>
      )}

      <div className="adm-actions">
        {d.user && <ContactClient user={d.user} />}
        <a className="adm-btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={tronscan('transaction', d.txId)} target="_blank" rel="noreferrer">
          Открыть в Tronscan
        </a>
      </div>
      {error && <div className="adm-error">{error}</div>}

      <div className="adm-grid">
        <Card title="Транзакция">
          <Row k="Сумма" v={fmtMicroExact(d.amountMicro)} big />
          <Row k="Хэш" v={d.txId} copy={d.txId} mono />
          <Row k="Отправитель" v={d.fromAddress ?? 'Неизвестно'} copy={d.fromAddress ?? undefined} mono />
          <Row k="Наш адрес" v={d.address} copy={d.address} mono />
          {d.blockNumber && <Row k="Блок" v={String(d.blockNumber)} />}
          <Row k="Подтверждено" v={d.confirmedAt ? fmtDateTime(d.confirmedAt) : 'Ещё нет'} />
          {d.adminNote && d.status !== 'rejected' && <Row k="Заметка" v={d.adminNote} />}
        </Card>

        <Card title="Чей платёж">
          <Row k="Адрес был выдан" v={d.issuedTo ? who(d.issuedTo) : 'Никому'} sub={d.requestId ? `Заявка №${d.requestId}${d.late ? ', после её окончания' : ''}` : undefined} />
          <Row k="Кошелёк пополнял" v={d.senderUsers.length ? senders : 'Никого'} tone={d.review === 'sender_conflict' ? 'warn' : undefined} />
          <Row k="Зачисляется" v={d.user ? who(d.user) : 'Не определён'} tone={d.user ? undefined : 'warn'} />
          {d.user && <Row k="Telegram ID" v={String(d.user.telegramId)} copy={String(d.user.telegramId)} />}
        </Card>

        <Card title="AML-проверка отправителя">
          {d.amlSignals.length === 0 && <div className="adm-muted">Проверка ещё не выполнялась</div>}
          {d.amlSignals.map((s) => (
            <Row
              key={s.source}
              k={AML_SOURCE[s.source] ?? s.source}
              v={s.error ? 'Не удалось проверить' : s.hit ? 'Найден' : 'Чисто'}
              sub={s.error ?? s.detail}
              tone={s.error ? 'warn' : s.hit ? 'danger' : 'ok'}
            />
          ))}
        </Card>
      </div>
    </div>
  );
}
