import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './admin/AdminApp';
import { App } from './App';
import { IS_DEMO } from './lib/api';
import { initTelegram } from './lib/telegram';
import { demoWarp } from './lib/backend';
import './styles.css';

initTelegram('#07090d');

/** Demo build: one page with a switch between the wallet and the admin panel, sharing one mock backend. */
function DemoShell() {
  const [view, setView] = useState<'wallet' | 'admin'>(() => (location.hash === '#admin' ? 'admin' : 'wallet'));
  const switchTo = (v: 'wallet' | 'admin') => {
    setView(v);
    try {
      history.replaceState(null, '', v === 'admin' ? '#admin' : '#wallet');
    } catch {
      // sandboxed frame: the switch still works, it just isn't kept in the URL
    }
    window.scrollTo(0, 0);
  };
  return (
    <>
      <div className="demo-switch">
        <button className={view === 'wallet' ? 'on' : ''} onClick={() => switchTo('wallet')}>Кошелёк</button>
        <button className={view === 'admin' ? 'on' : ''} onClick={() => switchTo('admin')}>Админка</button>
        {demoWarp && (
          <button className="warp" title="Перемотать время демо на 2 минуты" onClick={() => demoWarp?.(2 * 60_000)}>+2 мин</button>
        )}
      </div>
      <div className="demo-pad" />
      {view === 'wallet' ? <App /> : <AdminApp />}
    </>
  );
}

const isAdminRoute = location.pathname.replace(/\/+$/, '') === '/admin';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{IS_DEMO ? <DemoShell /> : isAdminRoute ? <AdminApp /> : <App />}</StrictMode>,
);
