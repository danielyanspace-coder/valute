import { useCallback, useEffect, useState } from 'react';
import type { AdminUsdtPayoutCounts, AdminUsdtPayoutDto } from '../../../shared/api';
import { shortUsdt } from '../../../shared/transfers';
import { USDT_PAYOUT_STATUS_LABEL, type UsdtPayoutStatus } from '../../../shared/usdtPayout';
import { QrCode } from '../components/deposit/QrCode';
import type { AdminApi } from '../lib/api';
import { fmtAgo, fmtDateTime, fmtMicroExact } from '../lib/format';
import { usePolling } from '../lib/useInterval';
import { Card, ContactClient, CopyChip, Row } from './ui';

type Filter = UsdtPayoutStatus | 'all';

const TABS: { id: Filter; label: string }[] = [
  { id: 'new', label: 'Новые' },
  { id: 'sent', label: 'Отправлены' },
  { id: 'rejected', label: 'Отклонены' },
  { id: 'all', label: 'Все' },
];

const CHIP: Record<UsdtPayoutStatus, { bg: string; fg: string }> = {
  new: { bg: 'rgba(127, 140, 255, 0.15)', fg: '#b8c0ff' },
  sent: { bg: 'rgba(47, 209, 139, 0.14)', fg: '#2fd18b' },
  rejected: { bg: 'rgba(139, 147, 163, 0.15)', fg: '#b3bac7' },
};

const AML_SOURCE: Record<string, string> = {
  tether_blacklist: 'Чёрный список Tether',
  ofac_sdn: 'Санкции OFAC',
  chainalysis_sanctions: 'Chainalysis',
};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const who = (u: AdminUsdtPayoutDto['user']) => (u.username ? `@${u.username}` : `${u.firstName} (ID ${u.id})`);

function Chip({ status }: { status: UsdtPayoutStatus }) {
  return <span className="adm-chip" style={{ background: CHIP[status].bg, color: CHIP[status].fg }}>{USDT_PAYOUT_STATUS_LABEL[status]}</span>;
}

/** USDT TRC-20 withdrawals: the operator sends from TronLink and pastes the hash. */
export function UsdtPayoutsPanel({ api, onOpenUser }: { api: AdminApi; onOpenUser: (id: number) => void }) {
  const [filter, setFilter] = useState<Filter>('new');
  const [items, setItems] = useState<AdminUsdtPayoutDto[]>([]);
  const [counts, setCounts] = useState<AdminUsdtPayoutCounts | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.usdtPayouts(filter).then(
      (r) => {
        setItems(r.items);
        setCounts(r.counts);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, [api, filter]);
  usePolling(load, 5000);
  useEffect(load, [load]);

  const current = items.find((p) => p.id === selected) ?? null;

  return (
    <div className="adm">
      <nav className="adm-tabs">
        {TABS.map((t) => {
          const n = t.id === 'all' || !counts ? null : counts[t.id];
          return (
            <button key={t.id} className={`adm-tab ${filter === t.id ? 'active' : ''}`} onClick={() => { setFilter(t.id); setSelected(null); setItems([]); }}>
              {t.label}
              {n !== null && n > 0 && <span className={`adm-count ${t.id === 'new' ? 'hot' : ''}`}>{n}</span>}
            </button>
          );
        })}
      </nav>
      {error && <div className="adm-error">{error}</div>}
      <div className={`adm-body ${current ? 'has-detail' : ''}`}>
        <section className="adm-list">
          {items.length === 0 && <div className="adm-empty">{filter === 'new' ? 'Новых заявок нет' : 'Заявок нет'}</div>}
          {items.map((p) => (
            <button key={p.id} className={`adm-row ${selected === p.id ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
              <div className="adm-row-top">
                <span className="adm-row-id">В-{p.id}</span>
                <Chip status={p.status} />
                <span className="adm-row-time">{fmtAgo(p.createdAt)}</span>
              </div>
              <div className="adm-row-amount">{fmtMicroExact(p.amountMicro)}</div>
              <div className="adm-row-sub">{who(p.user)} · на {short(p.address)}</div>
              {p.amlDecision === 'review' && <div className="adm-row-sub adm-warn-text">AML-проверка не выполнилась</div>}
              {p.sameAddressBefore === 0 && p.status === 'new' && <div className="adm-row-sub">Новый адрес для клиента</div>}
            </button>
          ))}
        </section>
        <section className="adm-detail">
          {current ? (
            <PayoutDetail key={current.id} api={api} p={current} onBack={() => setSelected(null)} onChanged={load} onOpenUser={onOpenUser} />
          ) : (
            <div className="adm-empty">Выберите заявку слева</div>
          )}
        </section>
      </div>
    </div>
  );
}

function PayoutDetail({ api, p, onBack, onChanged, onOpenUser }: {
  api: AdminApi;
  p: AdminUsdtPayoutDto;
  onBack: () => void;
  onChanged: () => void;
  onOpenUser: (id: number) => void;
}) {
  const [txId, setTxId] = useState('');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
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

  return (
    <div className="adm-d">
      <button className="adm-link adm-back" onClick={onBack}>← К списку</button>

      <div className="adm-card adm-d-head">
        <div className="adm-d-title">
          <span>В-{p.id} · USDT TRC-20</span>
          <Chip status={p.status} />
        </div>
        <div className="adm-d-amount">{fmtMicroExact(p.amountMicro)}</div>
        <div className="adm-muted">Создана {fmtDateTime(p.createdAt)} ({fmtAgo(p.createdAt)}) · {who(p.user)}</div>
      </div>

      {p.status === 'new' && p.amlDecision === 'review' && (
        <div className="adm-banner info">AML-проверка адреса не смогла выполниться. Проверьте адрес вручную в Tronscan перед отправкой.</div>
      )}
      {p.status === 'sent' && (
        <div className="adm-banner ok">
          Отправлено {p.finishedAt ? fmtDateTime(p.finishedAt) : ''}. {p.adminNote ? `Заметка: ${p.adminNote}.` : ''}
        </div>
      )}
      {p.status === 'rejected' && <div className="adm-banner">Отклонено: {p.rejectReason}. USDT вернулись клиенту.</div>}

      {p.status === 'new' && (
        <div className="adm-card up-send">
          <div className="adm-card-title">1. Отправьте из TronLink</div>
          <div className="up-send-body">
            <div className="up-qr"><QrCode value={p.address} size={156} /></div>
            <div className="up-fields">
              <div className="up-field">
                <span>Сумма, ровно</span>
                <div><b className="up-big">{shortUsdt(p.amountMicro)} USDT</b> <CopyChip label="Копировать" value={shortUsdt(p.amountMicro)} /></div>
              </div>
              <div className="up-field">
                <span>Адрес, сеть TRC-20</span>
                <div><code className="up-addr">{p.address}</code> <CopyChip label="Копировать" value={p.address} /></div>
              </div>
              <div className="adm-muted small">Комиссию {shortUsdt(p.feeMicro)} USDT клиент уже оплатил, она остаётся вам. Отправляйте из своего кошелька, не с адресов пополнения.</div>
            </div>
          </div>

          <div className="adm-card-title" style={{ marginTop: 14 }}>2. Вставьте хэш транзакции</div>
          <div className="adm-inline">
            <input id="usdt-tx" className="up-tx" placeholder="Хэш из TronLink или Tronscan, 64 символа" value={txId} onChange={(e) => setTxId(e.target.value.trim())} spellCheck={false} />
            <button className="adm-btn success" disabled={busy || !txId} onClick={() => run(() => api.usdtPayoutSent(p.id, txId, force, ''))}>
              {busy ? 'Проверяем…' : 'Отправил'}
            </button>
          </div>
          <label className="dp-own">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Закрыть без проверки в сети (только если TronGrid недоступен)
          </label>
          <div className="adm-muted small">Сервер проверит в блокчейне, что транзакция перевела не меньше {shortUsdt(p.amountMicro)} USDT на этот адрес, и пришлёт клиенту уведомление с хэшем.</div>

          <div className="adm-actions" style={{ marginTop: 10 }}>
            {!rejecting && <button className="adm-btn danger-ghost" disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button>}
          </div>
          {rejecting && (
            <div className="adm-inline">
              <input id="usdt-reason" placeholder="Причина, её увидит клиент" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="adm-btn danger" disabled={busy || !reason.trim()} onClick={async () => (await run(() => api.usdtPayoutReject(p.id, reason))) && setRejecting(false)}>
                Отклонить и вернуть USDT
              </button>
              <button className="adm-link" onClick={() => setRejecting(false)}>Отмена</button>
            </div>
          )}
          {error && <div className="adm-error">{error}</div>}
        </div>
      )}

      <div className="adm-actions">
        <ContactClient user={p.user} />
        <button className="adm-btn" onClick={() => onOpenUser(p.user.id)}>Профиль клиента</button>
        <a className="adm-btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={`https://tronscan.org/#/address/${p.address}`} target="_blank" rel="noreferrer">
          Адрес в Tronscan
        </a>
        {p.txId && (
          <a className="adm-btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={`https://tronscan.org/#/transaction/${p.txId}`} target="_blank" rel="noreferrer">
            Транзакция
          </a>
        )}
      </div>

      <div className="adm-grid">
        <Card title="Заявка">
          <Row k="Клиент получит" v={fmtMicroExact(p.amountMicro)} big />
          <Row k="Комиссия" v={fmtMicroExact(p.feeMicro)} />
          <Row k="Списано с баланса" v={fmtMicroExact(p.totalMicro)} />
          <Row k="Адрес" v={p.address} copy={p.address} mono />
          {p.txId && <Row k="Хэш" v={p.txId} copy={p.txId} mono />}
          <Row k="Баланс до заявки" v={fmtMicroExact(p.balanceBeforeMicro)} />
          <Row k="Выводы на этот адрес" v={p.sameAddressBefore ? `${p.sameAddressBefore} раньше` : 'Первый раз'} tone={p.sameAddressBefore ? 'ok' : 'warn'} />
        </Card>
        <Card title="AML-проверка адреса">
          {p.amlSignals.length === 0 && <div className="adm-muted">Проверка не выполнялась</div>}
          {p.amlSignals.map((s) => (
            <Row key={s.source} k={AML_SOURCE[s.source] ?? s.source} v={s.error ? 'Не удалось проверить' : s.hit ? 'Найден' : 'Чисто'} sub={s.error ?? s.detail} tone={s.error ? 'warn' : s.hit ? 'danger' : 'ok'} />
          ))}
        </Card>
      </div>
    </div>
  );
}
