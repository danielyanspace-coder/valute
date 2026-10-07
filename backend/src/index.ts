import { AmlService } from './aml/amlService.js';
import { ChainalysisSanctionsCheck } from './aml/chainalysisSanctions.js';
import { OfacSanctionsCheck } from './aml/ofacList.js';
import { TetherBlacklistCheck } from './aml/tetherBlacklist.js';
import type { AmlCheck } from './aml/types.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { Ledger } from './ledger/ledger.js';
import { NotificationService } from './notifications/notificationService.js';
import { TelegramMessenger } from './notifications/messenger.js';
import { AuditLog } from './audit/auditLog.js';
import { ObligationService } from './obligations/obligationService.js';
import { BroadcastService } from './broadcasts/broadcastService.js';
import { RateService } from './rates/rateService.js';
import { UserRepo } from './users/userRepo.js';
import { DepositService, type DepositServiceOptions } from './deposits/depositService.js';
import { USDT_MICRO } from '../../shared/payout.js';
import { TronGridClient } from './deposits/tronClient.js';
import { UsdtPayoutService } from './usdtPayouts/usdtPayoutService.js';
import { WithdrawalService } from './withdrawals/withdrawalService.js';
import { TransferService } from './transfers/transferService.js';
import { TelegramApi, WalletBot } from './bot/bot.js';
import { NoFineLookup } from './orders/fineLookup.js';
import { OrderService } from './orders/orderService.js';

/** Deal reminders go every 2 minutes; a 5-second tick keeps them on time. */
const DEAL_TICK_MS = 5_000;

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
const messenger = config.telegramBotToken
  ? new TelegramMessenger(config.telegramBotToken, config.webAppUrl, (chatId, blocked) => users.markBotBlocked(chatId, blocked))
  : null;
const notifications = new NotificationService(db, messenger, (err) => logError(err));
const audit = new AuditLog(db);
const withdrawals = new WithdrawalService(db, users, ledger, notifications, audit, messenger, config.webAppUrl);
const obligations = new ObligationService(db, ledger, users, notifications, audit, config.supportUsername);
withdrawals.obligations = obligations;
const broadcasts = new BroadcastService(db, users, messenger, audit, config.adminTelegramId);
let bot: WalletBot | null = null;
const botUsername = () => bot?.username || config.botUsername;
const transfers = new TransferService(db, users, ledger, notifications, withdrawals, botUsername);
// Plug a fines data provider (ШтрафовНет, shtraf.biz...) here once there is a contract.
const fineLookup = new NoFineLookup();
const orders = new OrderService(db, users, ledger, notifications, withdrawals, fineLookup, config.servicesDiscountPercent);

const aml = new AmlService(amlChecks);
const depositOpts: DepositServiceOptions = {
  minDepositMicro: Math.round(config.depositMinUsdt * USDT_MICRO),
  batchSize: config.depositBatch,
  audit,
};
const tronGrid = new TronGridClient(config.tronGridUrl, config.tronGridApiKey);
const deposits = new DepositService(db, tronGrid, aml, ledger, users, notifications, depositOpts);
const usdtPayouts = new UsdtPayoutService(db, ledger, users, notifications, aml, tronGrid, {
  feeMicro: Math.round(config.usdtWithdrawFeeUsdt * USDT_MICRO),
  minMicro: Math.round(config.usdtWithdrawMinUsdt * USDT_MICRO),
}, audit);

const app = buildApp({
  rates,
  aml,
  users,
  ledger,
  withdrawals,
  notifications,
  transfers,
  orders,
  fineLookup,
  servicesDiscountPercent: config.servicesDiscountPercent,
  botUsername,
  adminToken: config.adminToken,
  telegramBotToken: config.telegramBotToken,
  allowDevAuth: config.allowDevAuth,
  supportUsername: config.supportUsername,
  depositMinUsdt: config.depositMinUsdt,
  deposits,
  usdtPayouts,
  audit,
  obligations,
  broadcasts,
});
logError = (err) => app.log.error({ err }, 'bot notification failed');

// Deal timer: reminders 1-5 and the switch to "inactive". One pass at a time.
const dealLoop = async () => {
  try {
    await withdrawals.tick();
  } catch (err) {
    app.log.error({ err }, 'deal timer failed');
  }
  setTimeout(dealLoop, DEAL_TICK_MS).unref();
};
void dealLoop();
void broadcasts.run(); // resume a broadcast interrupted by a restart

// Deposit watcher: one pass at a time, never overlapping. Addresses are added in the admin panel.
{
  depositOpts.log = app.log;
  const loop = async () => {
    try {
      await deposits.tick();
    } catch (err) {
      app.log.error({ err }, 'deposit watcher failed');
    }
    setTimeout(loop, config.depositPollMs).unref();
  };
  void loop();
  if (!config.tronGridApiKey) app.log.warn('TRONGRID_API_KEY is not set: deposit checks use the anonymous TronGrid limit');
}

await rates.start(config.ratePollMs, (err) => app.log.error({ err }, 'rate refresh failed'));

if (config.telegramBotToken) {
  bot = new WalletBot(new TelegramApi(config.telegramBotToken), {
    users, ledger, transfers, withdrawals, publicUrl: config.webAppUrl, supportUsername: config.supportUsername, log: app.log,
  });
  // Without the bot the wallet still works; checks just cannot be posted to chats.
  await bot.start().catch((err) => app.log.error({ err }, 'bot failed to start'));
}
await app.listen({ port: config.port, host: '0.0.0.0' });
