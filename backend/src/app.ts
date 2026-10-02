import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireTelegramAuth } from './auth/plugin.js';
import type { RateService } from './rates/rateService.js';

export interface AppDeps {
  rates: RateService;
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
    // The exchange source and markup are internal — clients only see the wallet price.
    const { exchangeRate: _exchangeRate, markupPercent: _markupPercent, ...publicRate } = rate;
    return publicRate;
  });

  app.get('/api/market', async () => ({ coins: deps.rates.getMarket() }));

  app.get(
    '/api/me',
    { preHandler: requireTelegramAuth(deps.telegramBotToken, deps.allowDevAuth) },
    async (req) => ({ user: req.tgUser, balanceUsdt: '0.00' }),
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
