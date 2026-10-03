import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AdminCounts, AdminWithdrawalDto, AdminWithdrawalListItem, WithdrawalEventDto } from '../../../shared/api';
import { STATUS_LABEL, formatCard, formatRuPhone, isFinal, type WithdrawalStatus } from '../../../shared/payout';
import { LogoX } from '../components/icons';
import { MirMark, SbpMark } from '../components/brandMarks';
import { BankAvatar } from '../components/withdraw/BankPicker';
import { findBank } from '../../../shared/sbpBanks';
import { ApiError, IS_DEMO, type AdminApi } from '../lib/api';
import { adminApi } from '../lib/backend';
import {
  fmtAgo,
  fmtCountdown,
  fmtDateTime,
  fmtMicro,
  fmtMicroExact,
  fmtRub,
  fmtRub0,
  fmtTime,
} from '../lib/format';
import { usePolling } from '../lib/useInterval';
import './admin.css';

type Filter = WithdrawalStatus | 'all';

const TABS: { id: Filter; label: string }[] = [
  { id: 'pending', label: 'Новые' },
  { id: 'sent', label: 'Ждут подтверждения' },
  { id: 'disputed', label: 'Не поступили' },
  { id: 'completed', label: 'Выполненные' },
  { id: 'rejected', label: 'Отклонённые' },
  { id: 'all', label: 'Все' },
];

const TOKEN_KEY = 'adminToken';
const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
};
const writeToken = (t: string) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode: stay logged in for this tab only
  }
};

export function AdminApp() {
  const [token, setToken] = useState(() => (IS_DEMO ? 'demo' : readToken()));
  if (!token) return <Login onLogin={(t) => { writeToken(t); setToken(t); }} />;
  return <Panel api={adminApi(token)} onLogout={IS_DEMO ? undefined : () => { writeToken(''); setToken(''); }} />;
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi(value).list('pending');
      onLogin(value);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Неверный пароль' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="adm adm-login">
      <form className="adm-card adm-login-card" onSubmit={submit}>
        <div className="adm-brand"><LogoX size={26} /> Crypto IX · Админка</div>
        <label className="adm-field">
          <span>Пароль администратора</span>
          <input id="admin-token" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        {error && <div className="adm-error">{error}</div>}
        <button className="adm-btn primary" disabled={!value || busy}>{busy ? 'Проверяем…' : 'Войти'}</button>
      </form>
    </div>
  );
}

function Panel({ api, onLogout }: { api: AdminApi; onLogout?: () => void }) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [items, setItems] = useState<AdminWithdrawalListItem[]>([]);
  const [counts, setCounts] = useState<AdminCounts | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.list(filter).then(
      (r) => {
        setItems(r.items);
        setCounts(r.counts);
        setLoadError(null);
        document.title = r.counts.pending + r.counts.disputed > 0 ? `(${r.counts.pending + r.counts.disputed}) Админка` : 'Админка';
      },
      (e) => setLoadError((e as Error).message),
    );
  }, [api, filter]);
  usePolling(load, 5000);
  useEffect(load, [load]); // switch tabs instantly instead of waiting for the next poll

  return (
    <div className="adm">
      <header className="adm-top">
        <div className="adm-brand"><LogoX size={22} /> Crypto IX · Выводы</div>
        {onLogout && <button className="adm-link" onClick={onLogout}>Выйти</button>}
      </header>
      <nav className="adm-tabs">
        {TABS.map((t) => {
          const n = t.id === 'all' || !counts ? null : counts[t.id];
          return (
            <button key={t.id} className={`adm-tab ${filter === t.id ? 'active' : ''}`} onClick={() => { setFilter(t.id); setSelected(null); setItems([]); }}>
              {t.label}
              {n !== null && n > 0 && <span className={`adm-count ${t.id === 'pending' || t.id === 'disputed' ? 'hot' : ''}`}>{n}</span>}
            </button>
          );
        })}
      </nav>
      {loadError && <div className="adm-error">{loadError}</div>}
      <div className={`adm-body ${selected ? 'has-detail' : ''}`}>
        <section className="adm-list">
          {items.length === 0 && <div className="adm-empty">Заявок нет</div>}
          {items.map((w) => (
            <button key={w.id} className={`adm-row ${selected === w.id ? 'active' : ''}`} onClick={() => setSelected(w.id)}>
              <div className="adm-row-top">
                <span className="adm-row-id">#{w.id}</span>
                <StatusChip status={w.status} />
                <span className="adm-row-time">{fmtAgo(w.createdAt)}</span>
              </div>
              <div className="adm-row-main">
                <PayoutLogo method={w.method} bankId={w.bankId} destination={w.destination} size={34} />
                <div className="adm-row-text">
                  <div className="adm-row-amount">{fmtRub0(w.amountRub)}</div>
                  <div className="adm-row-sub">
                    {w.method === 'sbp' ? 'СБП' : 'Карта'} · {w.destination}
                  </div>
                </div>
              </div>
              <div className="adm-row-sub">
                {w.user.username ? `@${w.user.username}` : <span className="adm-warn-text">username скрыт</span>} · {w.user.firstName}
              </div>
            </button>
          ))}
        </section>
        <section className="adm-detail">
          {selected ? (
            <Detail key={selected} api={api} id={selected} onBack={() => setSelected(null)} onChanged={load} />
          ) : (
            <div className="adm-empty">Выберите заявку слева</div>
          )}
        </section>
      </div>
    </div>
  );
}

function Detail({ api, id, onBack, onChanged }: { api: AdminApi; id: number; onBack: () => void; onChanged: () => void }) {
  const [d, setD] = useState<AdminWithdrawalDto | null>(null);
  const [skew, setSkew] = useState(0);
  const [, tick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const apply = (x: AdminWithdrawalDto) => {
    setD(x);
    setSkew(x.serverNow - Date.now());
  };

  const load = useCallback(() => {
    api.get(id).then(apply, (e) => setError((e as Error).message));
  }, [api, id]);
  usePolling(load, 4000);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn: () => Promise<AdminWithdrawalDto>) => {
    setBusy(true);
    setError(null);
    try {
      apply(await fn());
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
  const left = d.confirmDeadline ? d.confirmDeadline - (Date.now() + skew) : 0;
  const noUsername = !u.username;

  return (
    <div className="adm-d">
      <button className="adm-link adm-back" onClick={onBack}>← К списку</button>

      <div className="adm-card adm-d-head">
        <div className="adm-d-title">
          <span>Заявка #{d.id}</span>
          <StatusChip status={d.status} />
        </div>
        <div className="adm-d-amount">{fmtRub0(d.amountRub)}</div>
        <div className="adm-muted">
          {fmtMicroExact(d.amountMicro)} по курсу {fmtRub(d.rate)}
          {d.exchangeRate ? ` · Rapira ${fmtRub(d.exchangeRate)}` : ''}
        </div>
        <div className="adm-muted">Создана {fmtDateTime(d.createdAt)} ({fmtAgo(d.createdAt)})</div>
      </div>

      {d.status === 'sent' && (
        <div className="adm-banner info">
          Платёж отмечен как отправленный в {fmtTime(d.sentAt!)}. Автоподтверждение через <b>{fmtCountdown(left)}</b>.
        </div>
      )}
      {d.status === 'disputed' && (
        <div className="adm-banner danger">
          <b>Пользователь сообщил, что деньги не поступили.</b>
          <div>
            {noUsername ? (
              <>Username скрыт, написать ему нельзя. Нажмите «Попросить связаться», и пользователь увидит окно с просьбой написать в поддержку.</>
            ) : (
              <>
                Написать пользователю:{' '}
                <a href={`https://t.me/${u.username}`} target="_blank" rel="noreferrer">@{u.username}</a>
              </>
            )}
          </div>
        </div>
      )}
      {d.contactRequestedAt && !isFinal(d.status) && (
        <div className="adm-banner info">
          Пользователь видит окно «Свяжитесь с поддержкой» с {fmtTime(d.contactRequestedAt)}. Кошелёк у него заблокирован, пока вы не
          подтвердите или не отклоните заявку.
        </div>
      )}
      {d.status === 'rejected' && <div className="adm-banner">Отклонена: {d.rejectReason}</div>}
      {d.status === 'completed' && (
        <div className="adm-banner ok">
          Выполнена {fmtDateTime(d.finishedAt!)}:{' '}
          {d.confirmedBy === 'user' ? 'пользователь подтвердил получение' : d.confirmedBy === 'auto' ? 'автоподтверждение' : 'подтверждено вручную'}
        </div>
      )}

      {!isFinal(d.status) && (
        <div className="adm-actions">
          {(d.status === 'pending' || d.status === 'disputed') && (
            <TwoStep
              label={d.status === 'disputed' ? 'Платёж отправлен повторно' : 'Платёж отправлен'}
              confirm={`Точно отправили ${fmtRub0(d.amountRub)}? Пользователю придёт запрос на подтверждение.`}
              tone="primary"
              busy={busy}
              onConfirm={() => act(() => api.markSent(d.id))}
            />
          )}
          {(d.status === 'sent' || d.status === 'disputed') && (
            <TwoStep
              label="Подтвердить вручную"
              confirm="USDT спишутся с баланса пользователя окончательно."
              tone="success"
              busy={busy}
              onConfirm={() => act(() => api.confirm(d.id))}
            />
          )}
          <button className={`adm-btn ${noUsername ? 'warn' : ''}`} disabled={busy} onClick={() => act(() => api.requestContact(d.id))}>
            Попросить связаться{d.contactRequestedAt ? ` (отправлено ${fmtTime(d.contactRequestedAt)})` : ''}
          </button>
          {(d.status === 'pending' || d.status === 'disputed') && !rejecting && (
            <button className="adm-btn danger-ghost" disabled={busy} onClick={() => setRejecting(true)}>Отклонить</button>
          )}
          {rejecting && (
            <div className="adm-inline">
              <input id="reject-reason" placeholder="Причина, её увидит пользователь" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="adm-btn danger" disabled={busy || !reason.trim()} onClick={async () => (await act(() => api.reject(d.id, reason))) && setRejecting(false)}>
                Отклонить и вернуть USDT
              </button>
              <button className="adm-link" onClick={() => setRejecting(false)}>Отмена</button>
            </div>
          )}
        </div>
      )}
      {error && <div className="adm-error">{error}</div>}

      <div className="adm-grid">
        <Card title="Реквизиты">
          <Row k="Способ" v={d.method === 'sbp' ? 'СБП по номеру телефона' : 'Перевод на карту'} />
          {d.method === 'sbp' ? (
            <>
              <Row k="Телефон" v={formatRuPhone(d.phone ?? '')} copy={`+${d.phone}`} big />
              <Row k="Банк" v={d.bankName ?? ''} sub={`ID НСПК ${d.bankId}`} icon={<PayoutLogo method="sbp" bankId={d.bankId} destination="" size={28} />} />
            </>
          ) : (
            <>
              <Row k="Номер карты" v={formatCard(d.cardNumber ?? '')} copy={d.cardNumber ?? ''} big />
              <Row
                k="Платёжная система"
                v={d.cardBrand ?? 'Не определена'}
                icon={d.cardBrand === 'МИР' ? <span className="adm-mir"><MirMark width={30} /></span> : undefined}
              />
            </>
          )}
          <Row k="Сумма к отправке" v={fmtRub0(d.amountRub)} copy={String(d.amountRub)} big />
        </Card>

        <Card title="Пользователь">
          <Row k="Имя" v={[u.firstName, u.lastName].filter(Boolean).join(' ')} />
          <Row
            k="Username"
            v={u.username ? `@${u.username}` : 'Скрыт'}
            href={u.username ? `https://t.me/${u.username}` : undefined}
            tone={u.username ? undefined : 'warn'}
          />
          <Row k="Telegram ID" v={String(u.telegramId)} copy={String(u.telegramId)} />
          <Row k="ID в системе" v={String(u.id)} />
          <Row k="Язык" v={u.languageCode ?? 'Не указан'} />
          <Row k="Регистрация" v={`${fmtDateTime(u.createdAt)} (${fmtAgo(u.createdAt)})`} />
          <Row k="Последний вход" v={fmtAgo(u.lastSeenAt)} />
          <Row
            k="Пропуски подтверждений"
            v={String(u.missedConfirmations)}
            tone={u.missedConfirmations >= 2 ? 'danger' : u.missedConfirmations === 1 ? 'warn' : undefined}
          />
          <Row k="Статус" v={u.blocked ? 'Заблокирован' : 'Активен'} tone={u.blocked ? 'danger' : 'ok'} />
          <BlockToggle api={api} userId={u.id} blocked={u.blocked} onDone={load} />
        </Card>

        <Card title="Баланс">
          <Row k="Доступно сейчас" v={fmtMicroExact(u.availableMicro)} big />
          <Row k="Заморожено" v={fmtMicroExact(u.frozenMicro)} />
          <Row k="Баланс до заявки" v={fmtMicroExact(d.balanceBeforeMicro)} />
          <Row k="Всего пополнено" v={fmtMicro(u.stats.depositedMicro)} />
          <Row k="Всего выведено" v={`${fmtRub0(u.stats.withdrawnRub)} · ${fmtMicro(u.stats.withdrawnMicro)}`} />
          <Row k="Заявок" v={`${u.stats.withdrawalsTotal}, выполнено ${u.stats.withdrawalsCompleted}, споров ${u.stats.disputes}`} />
          <Row k="Переводы" v={`получено ${fmtMicro(u.stats.transfersInMicro)}, отправлено ${fmtMicro(u.stats.transfersOutMicro)}`} />
          <Row k="В активных чеках" v={fmtMicro(u.stats.activeChecksMicro)} />
          <Adjust api={api} userId={u.id} onDone={load} />
        </Card>

        <Card title="Адреса пополнения">
          {u.depositAddresses.length === 0 && <div className="adm-muted">Адресов пока нет</div>}
          {u.depositAddresses.map((a) => (
            <Row key={a.chain} k={a.chain} v={a.address} copy={a.address} mono />
          ))}
        </Card>

        <Card title="Проверка">
          {d.sameDestinationUsers.length > 0 ? (
            <div className="adm-banner danger small">
              Эти реквизиты использовали другие аккаунты:{' '}
              {d.sameDestinationUsers.map((o) => `${o.username ? '@' + o.username : o.firstName} (ID ${o.id}, ${o.withdrawals} заявок)`).join(', ')}
            </div>
          ) : (
            <Row k="Реквизиты у других аккаунтов" v="Не встречались" tone="ok" />
          )}
          <Row k="IP" v={d.clientIp ?? 'Нет данных'} copy={d.clientIp ?? undefined} />
          <Row k="Платформа" v={d.platform ?? 'Нет данных'} />
          <Row k="Устройство" v={d.userAgent ?? 'Нет данных'} small />
        </Card>

        <Card title="Другие заявки пользователя">
          {d.recentWithdrawals.length === 0 && <div className="adm-muted">Это первая заявка</div>}
          {d.recentWithdrawals.map((r) => (
            <div key={r.id} className="adm-mini">
              <span>#{r.id}</span>
              <span>{fmtRub0(r.amountRub)}</span>
              <StatusChip status={r.status} />
              <span className="adm-muted">{fmtDateTime(r.createdAt)}</span>
            </div>
          ))}
        </Card>
      </div>

      <Card title="История заявки">
        <ol className="adm-timeline">
          {d.events.map((e) => (
            <li key={e.id} className={`actor-${e.actor}`}>
              <span className="adm-tl-time">{fmtDateTime(e.at)}</span>
              <span className="adm-tl-actor">{ACTOR[e.actor]}</span>
              <span className="adm-tl-text">{eventText(e)}</span>
            </li>
          ))}
        </ol>
        <div className="adm-inline">
          <input id="admin-note" placeholder="Заметка для истории, видна только админам" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="adm-btn" disabled={busy || !note.trim()} onClick={async () => (await act(() => api.note(d.id, note))) && setNote('')}>
            Добавить
          </button>
        </div>
      </Card>
    </div>
  );
}

const ACTOR = { user: 'Пользователь', admin: 'Админ', system: 'Система' } as const;

function eventText(e: WithdrawalEventDto): string {
  const x = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'created':
      return `Создал заявку: ${fmtRub0(Number(x.amountRub))}, заморожено ${fmtMicroExact(Number(x.amountMicro))} по курсу ${fmtRub(Number(x.rate))}`;
    case 'marked_sent':
      return `${x.resend ? 'Повторно отметил' : 'Отметил'} платёж отправленным, срок подтверждения до ${fmtTime(Number(x.deadline))}`;
    case 'confirmed':
      return x.by === 'user' ? 'Подтвердил получение' : x.by === 'auto' ? 'Автоподтверждение: 10 минут без ответа' : 'Подтвердил вручную';
    case 'disputed':
      return `Сообщил, что деньги не поступили. Username на момент спора: ${x.username ? '@' + x.username : 'скрыт'}`;
    case 'contact_requested':
      return 'Показал пользователю окно «Свяжитесь с поддержкой»';
    case 'rejected':
      return `Отклонил заявку, USDT возвращены на баланс. Причина: ${x.reason}`;
    case 'note':
      return `Заметка: ${x.text}`;
    default:
      return e.type;
  }
}

function StatusChip({ status }: { status: WithdrawalStatus }) {
  return <span className={`adm-chip s-${status}`}>{STATUS_LABEL[status]}</span>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="adm-card">
      <div className="adm-card-title">{title}</div>
      {children}
    </div>
  );
}

function Row(props: { k: string; v: string; sub?: string; icon?: ReactNode; copy?: string; href?: string; big?: boolean; mono?: boolean; small?: boolean; tone?: 'ok' | 'warn' | 'danger' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.copy!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      window.getSelection()?.selectAllChildren(document.getElementById(`v-${props.k}`)!);
    }
  };
  const cls = ['adm-v', props.big && 'big', props.mono && 'mono', props.small && 'small', props.tone && `t-${props.tone}`].filter(Boolean).join(' ');
  return (
    <div className="adm-kv">
      <span className="adm-k">{props.k}</span>
      <span className={`adm-v-wrap ${props.icon ? 'with-icon' : ''}`}>
        {props.icon}
        {props.href ? (
          <a id={`v-${props.k}`} className={cls} href={props.href} target="_blank" rel="noreferrer">{props.v}</a>
        ) : (
          <span id={`v-${props.k}`} className={cls}>{props.v}</span>
        )}
        {props.sub && <span className="adm-muted small">{props.sub}</span>}
      </span>
      {props.copy && <button className="adm-copy" onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</button>}
    </div>
  );
}

function TwoStep(props: { label: string; confirm: string; tone: 'primary' | 'success'; busy: boolean; onConfirm: () => Promise<boolean> }) {
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

function BlockToggle({ api, userId, blocked, onDone }: { api: AdminApi; userId: number; blocked: boolean; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className={`adm-btn small ${blocked ? '' : 'danger-ghost'}`} onClick={() => setAsking(true)}>
        {blocked ? 'Разблокировать' : 'Заблокировать вывод'}
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

function Adjust({ api, userId, onDone }: { api: AdminApi; userId: number; onDone: () => void }) {
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

/** Bank logo for SBP payouts, Mir mark for Mir cards, a neutral card tile otherwise. */
function PayoutLogo({ method, bankId, destination, size }: { method: 'sbp' | 'card'; bankId: string | null; destination: string; size: number }) {
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
