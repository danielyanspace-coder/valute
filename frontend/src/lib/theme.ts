import { useCallback, useEffect, useState } from 'react';
import { setTelegramColors, tg } from './telegram';

export type Theme = 'dark' | 'light';

const KEY = 'theme';
const BG: Record<Theme, string> = { dark: '#07090d', light: '#f2f4f8' };

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {
    // storage unavailable: fall back to Telegram's own theme
  }
  return tg?.colorScheme === 'light' ? 'light' : 'dark';
}

/**
 * Wallet theme: the user's choice, otherwise Telegram's colour scheme, otherwise dark.
 * Applied to <html data-theme> while the wallet is on screen (the admin panel stays dark).
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    setTelegramColors(BG[theme]);
    return () => {
      delete root.dataset.theme;
      setTelegramColors(BG.dark);
    };
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // not persisted, still switches for this session
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}
