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
import { TransferService } from './transfers/transferService.js';
import { TelegramApi, WalletBot } from './bot/bot.js';

const AUTO_CONFIRM_TICK_MS = 15_000;

const rates = new RateService({
  walletMarkupPercent: config.rateWalletMarkupPercent,
  qrPayDiscountPercent: config.rateQrPayDiscountPercent,
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
const botSender = config.telegramBotToken ? new TelegramBotSender(config.telegramBotToken, config.webAppUrl) : null;
const notifications = new NotificationService(db, botSender, (err) => logError(err));
const withdrawals = new WithdrawalService(db, users, ledger, notifications);
let bot: WalletBot | null = null;
const botUsername = () => bot?.username || config.botUsername;
const transfers = new TransferService(db, users, ledger, notifications, withdrawals, botUsername);

const app = buildApp({
  rates,
  aml: new AmlService(amlChecks),
  users,
  ledger,
  withdrawals,
  notifications,
  transfers,
  botUsername,
  adminToken: config.adminToken,
  telegramBotToken: config.telegramBotToken,
  allowDevAuth: config.allowDevAuth,
  supportUsername: config.supportUsername,
  depositMinUsdt: config.depositMinUsdt,
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

if (config.telegramBotToken) {
  bot = new WalletBot(new TelegramApi(config.telegramBotToken), {
    users, ledger, transfers, withdrawals, publicUrl: config.webAppUrl, log: app.log,
  });
  // Without the bot the wallet still works; checks just cannot be posted to chats.
  await bot.start().catch((err) => app.log.error({ err }, 'bot failed to start'));
}
await app.listen({ port: config.port, host: '0.0.0.0' });
