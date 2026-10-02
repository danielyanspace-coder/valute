import { AmlService } from './aml/amlService.js';
import { ChainalysisSanctionsCheck } from './aml/chainalysisSanctions.js';
import { OfacSanctionsCheck } from './aml/ofacList.js';
import { TetherBlacklistCheck } from './aml/tetherBlacklist.js';
import type { AmlCheck } from './aml/types.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { Ledger } from './ledger/ledger.js';
import { NotificationService, TelegramBotSender } from './notifications/notificationService.js';
import { RateService } from './rates/rateService.js';
import { UserRepo } from './users/userRepo.js';
import { WithdrawalService } from './withdrawals/withdrawalService.js';

const AUTO_CONFIRM_TICK_MS = 15_000;

const rates = new RateService({
  buyMarkupPercent: config.rateBuyMarkupPercent,
  sellDiscountPercent: config.rateSellDiscountPercent,
});
// Free AML layer only for now; a paid scoring provider plugs in as one more AmlCheck.
const amlChecks: AmlCheck[] = [new TetherBlacklistCheck(config.rpc), new OfacSanctionsCheck()];
if (config.chainalysisSanctionsApiKey) {
  amlChecks.push(new ChainalysisSanctionsCheck(config.chainalysisSanctionsApiKey));
}

const db = openDatabase(config.databasePath);
const users = new UserRepo(db);
const ledger = new Ledger(db);
let logError: (err: unknown) => void = console.error;
const bot = config.telegramBotToken ? new TelegramBotSender(config.telegramBotToken, config.webAppUrl) : null;
const notifications = new NotificationService(db, bot, (err) => logError(err));
const withdrawals = new WithdrawalService(db, users, ledger, notifications);

const app = buildApp({
  rates,
  aml: new AmlService(amlChecks),
  users,
  ledger,
  withdrawals,
  notifications,
  adminToken: config.adminToken,
  telegramBotToken: config.telegramBotToken,
  allowDevAuth: config.allowDevAuth,
  supportUsername: config.supportUsername,
});
logError = (err) => app.log.error({ err }, 'bot notification failed');

setInterval(() => {
  try {
    const n = withdrawals.autoConfirmDue();
    if (n) app.log.info({ n }, 'withdrawals auto-confirmed');
  } catch (err) {
    app.log.error({ err }, 'auto-confirm failed');
  }
}, AUTO_CONFIRM_TICK_MS).unref();

await rates.start(config.ratePollMs, (err) => app.log.error({ err }, 'rate refresh failed'));
await app.listen({ port: config.port, host: '0.0.0.0' });
