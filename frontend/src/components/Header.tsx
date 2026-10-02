export interface HeaderUser {
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  photoUrl?: string | null;
}
import { IconHeadset, IconHelp } from './icons';

interface Props {
  user: HeaderUser | null;
  supportUnread: number;
  onSupport: () => void;
  onHelp: () => void;
  onProfile: () => void;
}

export function Header({ user, supportUnread, onSupport, onHelp, onProfile }: Props) {
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
