const nf = (min: number, max = min) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });

const usd2 = nf(2);
const rub2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtUsd = (n: number) => `$ ${usd2.format(n)}`;
export const fmtRub = (n: number) => `${rub2.format(n)} ₽`;
export const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
export const fmtUsdt = (n: number) => `${nf(2, 2).format(n)} USDT`;
