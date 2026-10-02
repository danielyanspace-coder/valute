// Builds a standalone clickable demo: one HTML file with the current Rapira
// rates baked in, no backend or Telegram needed. Output: demo/crypto-ix-demo.html
//   npm run build -w backend && node scripts/build-demo.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RateService } from '../backend/dist/backend/src/rates/rateService.js';

const rates = new RateService({
  walletMarkupPercent: Number(process.env.RATE_WALLET_MARKUP_PERCENT ?? 5),
  qrPayDiscountPercent: Number(process.env.RATE_QR_PAY_DISCOUNT_PERCENT ?? 5),
});
await rates.refresh();
const { pair, walletRate, qrPayRate, change24hPercent, history, updatedAt } = rates.getWalletRate();
const snapshot = { rate: { pair, walletRate, qrPayRate, change24hPercent, history, updatedAt }, coins: rates.getMarket() };

execFileSync('npx', ['vite', 'build', '--mode', 'demo'], {
  cwd: new URL('../frontend', import.meta.url),
  env: { ...process.env, DEMO_SNAPSHOT: JSON.stringify(snapshot) },
  stdio: 'inherit',
});

const html = readFileSync(new URL('../frontend/dist-demo/index.html', import.meta.url), 'utf8');
mkdirSync(new URL('../demo', import.meta.url), { recursive: true });
writeFileSync(new URL('../demo/crypto-ix-demo.html', import.meta.url), html);
console.log(`demo/crypto-ix-demo.html — wallet ${walletRate} ₽, QR pay ${qrPayRate} ₽`);
