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
  rateMarkupPercent: num('RATE_MARKUP_PERCENT', 5),
  ratePollMs: num('RATE_POLL_MS', 15_000),
  allowDevAuth: process.env.ALLOW_DEV_AUTH === 'true',
};
