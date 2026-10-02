try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // no .env — rely on real environment variables
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
  rateBuyMarkupPercent: num('RATE_BUY_MARKUP_PERCENT', 5),
  rateSellDiscountPercent: num('RATE_SELL_DISCOUNT_PERCENT', 5),
  ratePollMs: num('RATE_POLL_MS', 15_000),
  allowDevAuth: process.env.ALLOW_DEV_AUTH === 'true',
  /** Bearer token for /api/admin/* until a real admin panel exists. Empty = admin API off. */
  adminToken: process.env.ADMIN_TOKEN ?? '',
  rpc: {
    TRON: process.env.TRON_RPC_URL || 'https://tron-rpc.publicnode.com/jsonrpc',
    ETH: process.env.ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  },
  chainalysisSanctionsApiKey: process.env.CHAINALYSIS_SANCTIONS_API_KEY ?? '',
};
