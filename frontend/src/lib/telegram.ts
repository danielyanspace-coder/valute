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
  disableVerticalSwipes?(): void;
  showScanQrPopup(params: { text?: string }, cb?: (text: string) => boolean | void): void;
  closeScanQrPopup(): void;
  openLink(url: string): void;
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
}

export function haptic(style: 'light' | 'medium' = 'light'): void {
  if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.impactOccurred(style);
}

export function hapticNotify(type: 'error' | 'success' | 'warning'): void {
  if (tg?.isVersionAtLeast('6.1')) tg.HapticFeedback.notificationOccurred(type);
}

export function canUseNativeQr(): boolean {
  return !!tg && tg.isVersionAtLeast('6.4');
}
