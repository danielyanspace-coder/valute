import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { AmlService } from './aml/amlService.js';
import type { Chain } from './aml/types.js';
import { requireTelegramAuth } from './auth/plugin.js';
import type { RateService } from './rates/rateService.js';

export interface AppDeps {
  rates: RateService;
  aml: AmlService;
  adminToken: string;
  telegramBotToken: string;
  allowDevAuth: boolean;
  staticDir?: string;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.register(cors);

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/rate', async (_req, reply) => {
    const rate = deps.rates.getWalletRate();
    if (!rate) return reply.code(503).send({ error: 'rate_unavailable' });
    // The exchange source and margins are internal — clients only see wallet prices.
    const { pair, buyRate, sellRate, change24hPercent, history, updatedAt } = rate;
    return { pair, buyRate, sellRate, change24hPercent, history, updatedAt };
  });

  app.get('/api/market', async () => ({ coins: deps.rates.getMarket() }));

  app.get(
    '/api/me',
    { preHandler: requireTelegramAuth(deps.telegramBotToken, deps.allowDevAuth) },
    async (req) => ({ user: req.tgUser, balanceUsdt: '0.00' }),
  );

  // Manual screening for operators: GET /api/admin/aml/check?chain=TRON&address=T...
  app.get<{ Querystring: { chain?: string; address?: string } }>(
    '/api/admin/aml/check',
    { preHandler: requireAdmin(deps.adminToken) },
    async (req, reply) => {
      const { chain, address } = req.query;
      if (!chain || !CHAINS.includes(chain as Chain) || !address) {
        return reply.code(400).send({ error: 'chain (TRON|BSC|ETH|TON) and address are required' });
      }
      return deps.aml.screen(chain as Chain, address.trim());
    },
  );

  const staticDir =
    deps.staticDir ?? fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  if (existsSync(staticDir)) {
    app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

const CHAINS: Chain[] = ['TRON', 'BSC', 'ETH', 'TON'];

function requireAdmin(token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
