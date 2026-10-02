import { AmlService } from './aml/amlService.js';
import { ChainalysisSanctionsCheck } from './aml/chainalysisSanctions.js';
import { OfacSanctionsCheck } from './aml/ofacList.js';
import { TetherBlacklistCheck } from './aml/tetherBlacklist.js';
import type { AmlCheck } from './aml/types.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { RateService } from './rates/rateService.js';

const rates = new RateService({
  buyMarkupPercent: config.rateBuyMarkupPercent,
  sellDiscountPercent: config.rateSellDiscountPercent,
});
// Free AML layer only for now; a paid scoring provider plugs in as one more AmlCheck.
const amlChecks: AmlCheck[] = [new TetherBlacklistCheck(config.rpc), new OfacSanctionsCheck()];
if (config.chainalysisSanctionsApiKey) {
  amlChecks.push(new ChainalysisSanctionsCheck(config.chainalysisSanctionsApiKey));
}

const app = buildApp({
  rates,
  aml: new AmlService(amlChecks),
  adminToken: config.adminToken,
  telegramBotToken: config.telegramBotToken,
  allowDevAuth: config.allowDevAuth,
});

await rates.start(config.ratePollMs, (err) => app.log.error({ err }, 'rate refresh failed'));
await app.listen({ port: config.port, host: '0.0.0.0' });
