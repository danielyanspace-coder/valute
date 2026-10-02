import type { TgUser } from '../lib/telegram';
import { IconHeadset, IconHelp } from './icons';

interface Props {
  user: TgUser | null;
  supportUnread: number;
  onSupport: () => void;
  onHelp: () => void;
  onProfile: () => void;
}

export function Header({ user, supportUnread, onSupport, onHelp, onProfile }: Props) {
  const name = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'Гость';
  const initials = name.slice(0, 1).toUpperCase();
  return (
    <header className="header">
      <button className="header-user" onClick={onProfile}>
        <div className="avatar">
          {user?.photo_url ? <img src={user.photo_url} alt="" /> : <span>{initials}</span>}
          <i className="online-dot" />
        </div>
        <div className="header-names">
          <div className="header-name">{name}</div>
          {user?.username && <div className="header-username">@{user.username}</div>}
        </div>
      </button>
      <div className="header-actions">
        <button className="icon-btn" onClick={onSupport} aria-label="Поддержка">
          <IconHeadset size={18} />
          {supportUnread > 0 && <span className="badge">{supportUnread > 99 ? '99+' : supportUnread}</span>}
        </button>
        <button className="icon-btn" onClick={onHelp} aria-label="Помощь"><IconHelp size={18} /></button>
      </div>
    </header>
  );
}
