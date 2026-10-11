import { useCallback, useState } from 'react';
import { LogoX } from '../components/icons';
import { ApiError, IS_DEMO, type AdminApi } from '../lib/api';
import { adminApi } from '../lib/backend';
import { usePolling } from '../lib/useInterval';
import { ArchivePanel } from './ArchivePanel';
import { BroadcastsPanel } from './BroadcastsPanel';
import { DealDrawer } from './DealDetail';
import { DealsBoard } from './DealsBoard';
import { DepositsPanel } from './DepositsPanel';
import { JournalPanel } from './JournalPanel';
import { ObligationsPanel } from './ObligationsPanel';
import { OrdersPanel } from './OrdersPanel';
import { UsdtPayoutsPanel } from './UsdtPayoutsPanel';
import { StatsPanel } from './StatsPanel';
import { GiveawaysPanel } from './GiveawaysPanel';
import { UsersPanel } from './UsersPanel';
import './admin.css';

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
  return <Shell api={adminApi(token)} onLogout={IS_DEMO ? undefined : () => { writeToken(''); setToken(''); }} />;
}

type Section = 'deals' | 'usdt' | 'giveaways' | 'stats' | 'archive' | 'users' | 'obligations' | 'journal' | 'broadcasts' | 'orders' | 'deposits';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'deals', label: 'Сделки' },
  { id: 'usdt', label: 'Вывод USDT' },
  { id: 'stats', label: 'Статистика' },
  { id: 'giveaways', label: 'Розыгрыши и IX Black' },
  { id: 'archive', label: 'Архив' },
  { id: 'users', label: 'Пользователи' },
  { id: 'obligations', label: 'Теневые заморозки' },
  { id: 'journal', label: 'Журнал' },
  { id: 'broadcasts', label: 'Рассылки' },
  { id: 'orders', label: 'МК' },
  { id: 'deposits', label: 'Пополнения' },
];

/** Operator workspace: deals board first, everything else one tap away. */
function Shell({ api, onLogout }: { api: AdminApi; onLogout?: () => void }) {
  const [section, setSection] = useState<Section>('deals');
  const [userId, setUserId] = useState<number | null>(null);
  const [journalUser, setJournalUser] = useState<number | null>(null);
  const [deal, setDeal] = useState<number | null>(null);
  // New USDT withdrawals wait for a manual transfer: keep the count in the menu.
  const [usdtNew, setUsdtNew] = useState(0);
  const pollUsdt = useCallback(() => {
    api.usdtPayouts('new').then((r) => setUsdtNew(r.counts.new), () => {});
  }, [api]);
  usePolling(pollUsdt, 10_000);

  const openUser = (id: number | null) => {
    setDeal(null);
    setUserId(id);
    setSection('users');
    window.scrollTo(0, 0);
  };
  const openJournal = (id: number) => {
    setJournalUser(id);
    setSection('journal');
  };

  return (
    <div className="adm">
      <header className="adm-top">
        <div className="adm-brand"><LogoX size={22} /> Crypto IX</div>
        {onLogout ? <button className="adm-link" onClick={onLogout}>Выйти</button> : <span />}
      </header>
      <nav className="ab-nav">
        {SECTIONS.map((s) => (
          <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => { setSection(s.id); if (s.id === 'users') setUserId(null); }}>
            {s.label}
            {s.id === 'usdt' && usdtNew > 0 && <span className="ab-nav-count">{usdtNew}</span>}
          </button>
        ))}
      </nav>

      {section === 'deals' && <DealsBoard api={api} onOpenUser={openUser} />}
      {section === 'archive' && <ArchivePanel api={api} onOpenDeal={setDeal} />}
      {section === 'users' && <UsersPanel api={api} userId={userId} onOpenUser={openUser} onOpenDeal={setDeal} onOpenJournal={openJournal} />}
      {section === 'obligations' && <ObligationsPanel api={api} onOpenUser={openUser} onOpenDeal={setDeal} />}
      {section === 'journal' && <JournalPanel api={api} userId={journalUser} onClearUser={() => setJournalUser(null)} onOpenDeal={setDeal} onOpenUser={openUser} />}
      {section === 'broadcasts' && <BroadcastsPanel api={api} />}
      {section === 'orders' && <OrdersPanel api={api} top={null} />}
      {section === 'stats' && <StatsPanel api={api} onOpenUser={openUser} />}
      {section === 'giveaways' && <GiveawaysPanel api={api} onOpenUser={openUser} />}
      {section === 'usdt' && <UsdtPayoutsPanel api={api} onOpenUser={openUser} />}
      {section === 'deposits' && <DepositsPanel api={api} top={null} />}

      {deal !== null && <DealDrawer api={api} id={deal} onClose={() => setDeal(null)} onChanged={() => {}} onOpenUser={openUser} onOpenDeal={setDeal} />}
    </div>
  );
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
      await adminApi(value).board();
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
