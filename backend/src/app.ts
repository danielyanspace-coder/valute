import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { AmlService } from './aml/amlService.js';
import { requireTelegramAuth } from './auth/plugin.js';
import type { Ledger } from './ledger/ledger.js';
import type { NotificationService } from './notifications/notificationService.js';
import type { RateService } from './rates/rateService.js';
import { adminRoutes } from './routes/adminRoutes.js';
import { userRoutes } from './routes/userRoutes.js';
import type { UserRepo } from './users/userRepo.js';
import { AppError, type WithdrawalService } from './withdrawals/withdrawalService.js';
import { renderCheckJpeg } from './checks/checkImage.js';
import type { TransferService } from './transfers/transferService.js';
import type { OrderService } from './orders/orderService.js';
import type { FineLookup } from './orders/fineLookup.js';
import type { DepositService } from './deposits/depositService.js';
import type { UsdtPayoutService } from './usdtPayouts/usdtPayoutService.js';
import type { StatsService } from './stats/statsService.js';
import type { AuditLog } from './audit/auditLog.js';
import type { ObligationService } from './obligations/obligationService.js';
import type { BroadcastService } from './broadcasts/broadcastService.js';

export interface AppDeps {
  rates: RateService;
  aml: AmlService;
  users: UserRepo;
  ledger: Ledger;
  withdrawals: WithdrawalService;
  notifications: NotificationService;
  transfers: TransferService;
  orders: OrderService;
  fineLookup: FineLookup;
  servicesDiscountPercent: number;
  botUsername: () => string;
  adminToken: string;
  telegramBotToken: string;
  allowDevAuth: boolean;
  supportUsername: string;
  depositMinUsdt: number;
  deposits: DepositService;
  usdtPayouts: UsdtPayoutService;
  stats: StatsService;
  audit: AuditLog;
  obligations: ObligationService;
  broadcasts: BroadcastService;
  staticDir?: string;
}

export function buildApp(deps: AppDeps) {
  // trustProxy: the app runs behind nginx/caddy; req.ip must be the client, not the proxy.
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true });
  app.register(cors);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    if ((err as { validation?: unknown }).validation) return reply.code(400).send({ error: 'bad_request', message: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Что-то пошло не так, попробуйте ещё раз' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/rate', async (_req, reply) => {
    const rate = deps.rates.getWalletRate();
    if (!rate) return reply.code(503).send({ error: 'rate_unavailable' });
    // The exchange source and margins are internal; clients only see wallet prices.
    const { pair, walletRate, qrPayRate, change24hPercent, history, updatedAt } = rate;
    return { pair, walletRate, qrPayRate, change24hPercent, history, updatedAt };
  });

  app.get('/api/market', async () => ({ coins: deps.rates.getMarket() }));

  // Public check artwork; Telegram downloads it for inline results. /api/checks/image/10.jpg
  app.get<{ Params: { amount: string } }>('/api/checks/image/:amount', async (req, reply) => {
    const amount = req.params.amount.replace(/\.jpg$/, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) return reply.code(400).send({ error: 'bad_amount' });
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(renderCheckJpeg(amount));
  });

  app.register(async (scope) => {
    scope.addHook(
      'preHandler',
      requireTelegramAuth(deps.telegramBotToken, deps.allowDevAuth, (tg) => deps.users.upsertFromTelegram(tg)),
    );
    userRoutes(scope, deps);
  });

  app.register(async (scope) => {
    scope.addHook('preHandler', requireAdmin(deps.adminToken));
    adminRoutes(scope, deps);
  });

  const staticDir = deps.staticDir ?? findFrontendDist();
  if (staticDir) {
    app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html'); // SPA: /admin and other client routes
    });
  }

  return app;
}

/** frontend/dist, whether running from src (tsx) or from the compiled dist folder. */
function findFrontendDist(): string | undefined {
  for (const rel of ['../../frontend/dist', '../../../../frontend/dist']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(dir)) return dir;
  }
}

function requireAdmin(token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
