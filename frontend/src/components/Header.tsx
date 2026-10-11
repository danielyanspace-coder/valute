export interface HeaderUser {
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  photoUrl?: string | null;
}
import { IconHeadset, IconHelp, IconMoon, IconSun } from './icons';
import { PremiumChip } from './premium/Premium';

interface Props {
  user: HeaderUser | null;
  supportUnread: number;
  onSupport: () => void;
  onHelp: () => void;
  onProfile: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  premium?: boolean;
}

export function Header({ user, supportUnread, onSupport, onHelp, onProfile, theme, onToggleTheme, premium }: Props) {
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ') : '';
  const initials = name.slice(0, 1).toUpperCase() || '·';
  return (
    <header className="header">
      <button className="header-user" onClick={onProfile}>
        <div className="avatar">
          {user?.photoUrl ? <img src={user.photoUrl} alt="" /> : <span>{initials}</span>}
          <i className="online-dot" />
        </div>
        <div className="header-names">
          <div className="header-name">{name}</div>
          {premium && <PremiumChip />}
        </div>
      </button>
      <div className="header-actions">
        <button className="icon-btn" onClick={onSupport} aria-label="Поддержка">
          <IconHeadset size={18} />
          {supportUnread > 0 && <span className="badge">{supportUnread > 99 ? '99+' : supportUnread}</span>}
        </button>
        <button className="icon-btn" onClick={onHelp} aria-label="Помощь"><IconHelp size={18} /></button>
        <button
          className="icon-btn theme-btn"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {theme === 'dark' ? <IconMoon size={18} /> : <IconSun size={18} />}
        </button>
      </div>
    </header>
  );
}
