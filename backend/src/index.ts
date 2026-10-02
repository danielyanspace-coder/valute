import { buildApp } from './app.js';
import { config } from './config.js';
import { RateService } from './rates/rateService.js';

const rates = new RateService(config.rateMarkupPercent);
const app = buildApp({
  rates,
  telegramBotToken: config.telegramBotToken,
  allowDevAuth: config.allowDevAuth,
});

await rates.start(config.ratePollMs, (err) => app.log.error({ err }, 'rate refresh failed'));
await app.listen({ port: config.port, host: '0.0.0.0' });
