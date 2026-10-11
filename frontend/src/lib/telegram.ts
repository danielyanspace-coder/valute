// Minimal typings for the parts of Telegram.WebApp we use.
// Full reference: https://core.telegram.org/bots/webapps#initializing-mini-apps

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: TgUser };
  version: string;
  platform: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor?(color: string): void;
  colorScheme?: 'light' | 'dark';
  disableVerticalSwipes?(): void;
  requestFullscreen?(): void;
  showScanQrPopup(params: { text?: string }, cb?: (text: string) => boolean | void): void;
  closeScanQrPopup(): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  switchInlineQuery?(query: string, chooseChatTypes?: ('users' | 'bots' | 'groups' | 'channels')[]): void;
  showConfirm?(message: string, cb: (ok: boolean) => void): void;
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TgWebApp };
  }
}

/** Telegram injects WebApp even in a plain browser; initData is empty there. */
export const tg: TgWebApp | undefined = window.Telegram?.WebApp?.initData
  ? window.Telegram.WebApp
  : undefined;

export function initTelegram(bg: string): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (tg.isVersionAtLeast('6.1')) {
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
  }
  if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes?.();
  // Full screen like Crypto Bot, on phones only: on desktop it would cover the whole monitor.
  if (tg.isVersionAtLeast('8.0') && ['ios', 'android'].includes(tg.platform)) tg.requestFullscreen?.();
}

/** Paints Telegram's own header and background to match the current theme. */
export function setTelegramColors(bg: string): void {
  if (!tg?.isVersionAtLeast('6.1')) return;
  tg.setHeaderColor(bg);
  tg.setBackgroundColor(bg);
  if (tg.isVersionAtLeast('7.10')) tg.setBottomBarColor?.(bg);
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light'): void {
  if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.impactOccurred(style);
}

export function hapticNotify(type: 'error' | 'success' | 'warning'): void {
  if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.notificationOccurred(type);
}

export function canUseNativeQr(): boolean {
  return !!tg && tg.isVersionAtLeast('6.4');
}

/** Opens a Telegram chat (support) inside Telegram, or in a new tab elsewhere. */
export function openTelegramChat(username: string, text?: string): void {
  const url = `https://t.me/${username}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  if (tg?.isVersionAtLeast('6.1')) tg.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

/**
 * Opens Telegram's chat picker with "@bot <query>" prefilled, so the user posts a check to any chat.
 * Returns false outside Telegram (or on old clients) so the caller can fall back to copying a link.
 */
export function shareInline(query: string): boolean {
  if (!tg?.isVersionAtLeast('6.7') || !tg.switchInlineQuery) return false;
  tg.switchInlineQuery(query, ['users', 'groups', 'channels']);
  return true;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
