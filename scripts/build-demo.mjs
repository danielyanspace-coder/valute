// Builds a standalone clickable demo: one HTML file with the current Rapira
// rates baked in, no backend or Telegram needed. Output: demo/crypto-ix-demo.html
//   npm run build -w backend && node scripts/build-demo.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RateService } from '../backend/dist/rates/rateService.js';

const rates = new RateService({
  buyMarkupPercent: Number(process.env.RATE_BUY_MARKUP_PERCENT ?? 5),
  sellDiscountPercent: Number(process.env.RATE_SELL_DISCOUNT_PERCENT ?? 5),
});
await rates.refresh();
const { pair, buyRate, sellRate, change24hPercent, history, updatedAt } = rates.getWalletRate();
const snapshot = { rate: { pair, buyRate, sellRate, change24hPercent, history, updatedAt }, coins: rates.getMarket() };

execFileSync('npx', ['vite', 'build', '--mode', 'demo'], {
  cwd: new URL('../frontend', import.meta.url),
  env: { ...process.env, DEMO_SNAPSHOT: JSON.stringify(snapshot) },
  stdio: 'inherit',
});

const html = readFileSync(new URL('../frontend/dist-demo/index.html', import.meta.url), 'utf8');
mkdirSync(new URL('../demo', import.meta.url), { recursive: true });
writeFileSync(new URL('../demo/crypto-ix-demo.html', import.meta.url), html);
console.log(`demo/crypto-ix-demo.html — buy ${buyRate} ₽, sell ${sellRate} ₽`);
