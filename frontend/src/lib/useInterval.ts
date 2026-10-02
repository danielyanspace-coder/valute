import { useEffect, useRef } from 'react';

/** Runs `fn` immediately and then every `ms`; pauses while the tab is hidden. */
export function usePolling(fn: () => void, ms: number): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') ref.current();
    }, ms);
    const onVisible = () => document.visibilityState === 'visible' && ref.current();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // storage unavailable (private mode) — preference just won't persist
  }
}
