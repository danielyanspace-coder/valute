import { USDT_MICRO } from '../../../shared/payout';

const nf = (min: number, max = min) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

const usd2 = nf(2);
const rub2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rub0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

export const fmtUsd = (n: number) => `$ ${usd2.format(n)}`;
export const fmtRub = (n: number) => `${rub2.format(n)} ₽`;
/** Whole rubles: "5 000 ₽". */
export const fmtRub0 = (n: number) => `${rub0.format(n)} ₽`;
export const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
export const fmtUsdt = (n: number) => `${nf(2, 2).format(n)} USDT`;
export const fmtMicro = (micro: number) => fmtUsdt(micro / USDT_MICRO);
/** Exact amount for audit screens: up to 6 decimals. */
export const fmtMicroExact = (micro: number) => `${nf(2, 6).format(micro / USDT_MICRO)} USDT`;

export const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** "07:41" */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtAgo(ts: number, now = Date.now()): string {
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
