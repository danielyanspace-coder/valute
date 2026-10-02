import type { ReactNode } from 'react';
import { IconGrid, IconHistory, IconHome, IconQr, IconUser } from './icons';

export type Tab = 'home' | 'history' | 'services' | 'profile';

const LEFT: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'home', label: 'Главная', icon: <IconHome size={30} /> },
  { id: 'history', label: 'История', icon: <IconHistory size={30} /> },
];
const RIGHT: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'services', label: 'Сервисы', icon: <IconGrid size={30} /> },
  { id: 'profile', label: 'Профиль', icon: <IconUser size={30} /> },
];

export function BottomNav({ tab, onTab, onScan }: { tab: Tab; onTab: (t: Tab) => void; onScan: () => void }) {
  const item = (t: (typeof LEFT)[number]) => (
    <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
      {t.icon}
      <span>{t.label}</span>
    </button>
  );
  return (
    <div className="bottom-nav">
      {LEFT.map(item)}
      <button className="nav-scan" onClick={onScan} aria-label="Сканировать QR"><IconQr size={34} /></button>
      {RIGHT.map(item)}
    </div>
  );
}
