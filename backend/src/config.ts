// Repo-root .env, from src (tsx) or from dist/backend/src (compiled). Real env vars win.
for (const rel of ['../../.env', '../../../../.env']) {
  try {
    process.loadEnvFile(new URL(rel, import.meta.url));
    break;
  } catch {
    // not there; fall back to real environment variables
  }
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return value;
}

export const config = {
  port: num('PORT', 8080),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  rateWalletMarkupPercent: num('RATE_WALLET_MARKUP_PERCENT', 5),
  rateQrPayDiscountPercent: num('RATE_QR_PAY_DISCOUNT_PERCENT', 5),
  ratePollMs: num('RATE_POLL_MS', 15_000),
  allowDevAuth: process.env.ALLOW_DEV_AUTH === 'true',
  /** Password for the admin panel (/admin) and /api/admin/*. Empty = admin off. */
  adminToken: process.env.ADMIN_TOKEN ?? '',
  /** Your own Telegram ID: broadcasts are test-sent here first. */
  adminTelegramId: num('ADMIN_TELEGRAM_ID', 0),
  rpc: {
    TRON: process.env.TRON_RPC_URL || 'https://tron-rpc.publicnode.com/jsonrpc',
    ETH: process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  },
  chainalysisSanctionsApiKey: process.env.CHAINALYSIS_SANCTIONS_API_KEY ?? '',
  /** Deposits below this are not credited (dust and spam transfers). */
  depositMinUsdt: num('DEPOSIT_MIN_USDT', 10),
  /** Account-level extended PUBLIC key m/44'/195'/0' (see scripts/tron-wallet.mjs). Empty: no addresses issued. */
  tronXpub: (process.env.TRON_XPUB ?? '').trim(),
  /** Deposit watcher. A free key from trongrid.io lifts the anonymous rate limit. */
  tronGridUrl: process.env.TRONGRID_URL || 'https://api.trongrid.io',
  tronGridApiKey: process.env.TRONGRID_API_KEY ?? '',
  depositPollMs: num('DEPOSIT_POLL_MS', 5000),
  /** Addresses checked per poll; ~2 requests each. Keep low without an API key. */
  depositBatch: num('DEPOSIT_BATCH', 3),
  /** Fines, parking, Steam: the user pays this much less USDT than at the Rapira price. */
  servicesDiscountPercent: num('SERVICES_DISCOUNT_PERCENT', 10),
  databasePath: process.env.DATABASE_PATH || 'data/wallet.db',
  /** Support account users are sent to, without "@". */
  supportUsername: (process.env.SUPPORT_USERNAME ?? '').replace(/^@/, ''),
  /** HTTPS URL of the Mini App; adds an "open wallet" button to bot messages. */
  webAppUrl: process.env.WEBAPP_URL ?? '',
  /** Used for check links until the bot reports its own username via getMe. */
  botUsername: (process.env.BOT_USERNAME ?? '').replace(/^@/, ''),
};
