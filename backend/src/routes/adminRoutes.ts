import type { FastifyInstance } from 'fastify';
import type { AdminUserListItem, AdminUserPageDto, ArchiveQuery, BroadcastRequest, CreateObligationRequest, JournalQuery } from '../../../shared/api.js';
import { USDT_MICRO } from '../../../shared/payout.js';
import type { AmlService } from '../aml/amlService.js';
import type { Chain } from '../aml/types.js';
import type { AuditLog } from '../audit/auditLog.js';
import type { BroadcastService } from '../broadcasts/broadcastService.js';
import type { Ledger } from '../ledger/ledger.js';
import type { ObligationService } from '../obligations/obligationService.js';
import type { UserRepo } from '../users/userRepo.js';
import type { OrderService } from '../orders/orderService.js';
import type { OrderStatus } from '../../../shared/services.js';
import type { DepositService } from '../deposits/depositService.js';
import type { UsdtPayoutService } from '../usdtPayouts/usdtPayoutService.js';
import { AppError, type WithdrawalService } from '../withdrawals/withdrawalService.js';

const CHAINS: Chain[] = ['TRON', 'BSC', 'ETH', 'TON'];
/** Broadcast images come as base64 inside JSON. */
const PHOTO_BODY_LIMIT = 8 * 1024 * 1024;

export interface AdminRouteDeps {
  withdrawals: WithdrawalService;
  users: UserRepo;
  ledger: Ledger;
  aml: AmlService;
  orders: OrderService;
  deposits: DepositService;
  usdtPayouts: UsdtPayoutService;
  audit: AuditLog;
  obligations: ObligationService;
  broadcasts: BroadcastService;
  supportUsername: string;
}

type Body = Record<string, unknown>;
const ext = (b: Body) => ({ externalId: typeof b.externalId === 'string' ? b.externalId : null });

/** Routes for the admin panel. Registered inside a scope that already checks the admin token. */
export function adminRoutes(app: FastifyInstance, deps: AdminRouteDeps) {
  const { withdrawals } = deps;

  // ---------- Deals ----------

  app.get('/api/admin/deals/board', async () => withdrawals.board());
  app.get<{ Querystring: ArchiveQuery }>('/api/admin/deals/archive', async (req) => ({ items: withdrawals.archive(req.query ?? {}) }));
  app.get<{ Params: { id: string } }>('/api/admin/deals/:id', async (req) => withdrawals.adminGet(Number(req.params.id)));

  const action = (path: string, run: (id: number, body: Body) => unknown) =>
    app.post<{ Params: { id: string }; Body: Body }>(`/api/admin/deals/:id/${path}`, async (req) => {
      const id = Number(req.params.id);
      run(id, req.body ?? {});
      return withdrawals.adminGet(id);
    });

  action('take', (id) => withdrawals.take(id));
  action('entered', (id) => withdrawals.entered(id));
  action('requisite-off', (id) => withdrawals.requisiteOff(id));
  action('confirm', (id, b) => withdrawals.confirm(id, ext(b)));
  action('close', (id, b) => withdrawals.close(id, ext(b)));
  action('reopen', (id) => withdrawals.reopen(id));
  action('accept-correction', (id, b) => withdrawals.acceptCorrection(id, { ...ext(b), createObligation: b.createObligation === true }));
  action('accept-original', (id, b) => withdrawals.acceptOriginal(id, ext(b)));
  action('cancel', (id, b) => withdrawals.cancel(id, { ...ext(b), reason: typeof b.reason === 'string' ? b.reason : '' }));
  action('external-id', (id, b) => withdrawals.setExternalId(id, String(b.externalId ?? '')));
  action('note', (id, b) => withdrawals.addNote(id, String(b.text ?? '')));

  // ---------- Users ----------

  app.get<{ Querystring: { q?: string } }>('/api/admin/users', async (req) => ({
    items: deps.users.search(req.query.q ?? '').map((u): AdminUserListItem => {
      const b = deps.ledger.balances(u.id);
      return {
        id: u.id,
        telegramId: u.telegram_id,
        username: u.username,
        firstName: u.first_name,
        lastName: u.last_name,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
        availableMicro: b.availableMicro,
        frozenMicro: b.frozenMicro,
        supportLocked: !!u.support_lock_at,
        blocked: !!u.blocked,
        activeDeals: withdrawals.activeCount(u.id),
        obligationsLeftMicro: deps.obligations.leftForUser(u.id),
      };
    }),
  }));

  const userPage = (id: number): AdminUserPageDto => ({
    ...withdrawals.adminUser(id),
    deals: withdrawals.forUser(id),
    obligations: deps.obligations.list({ userId: id }),
  });

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => userPage(Number(req.params.id)));

  app.post<{ Params: { id: string }; Body: { amountUsdt?: number; comment?: string } }>('/api/admin/users/:id/adjust', async (req) => {
    const id = Number(req.params.id);
    withdrawals.adjustBalance(id, Math.round(Number(req.body?.amountUsdt) * USDT_MICRO), String(req.body?.comment ?? ''));
    return userPage(id);
  });

  app.post<{ Params: { id: string }; Body: { blocked?: boolean } }>('/api/admin/users/:id/block', async (req) => {
    const id = Number(req.params.id);
    withdrawals.setBlocked(id, !!req.body?.blocked);
    return userPage(id);
  });

  app.post<{ Params: { id: string }; Body: { locked?: boolean } }>('/api/admin/users/:id/support-lock', async (req) => {
    const id = Number(req.params.id);
    withdrawals.setSupportLock(id, !!req.body?.locked, deps.supportUsername);
    return userPage(id);
  });

  // ---------- Shadow obligations ----------

  app.get<{ Querystring: { status?: string; userId?: string } }>('/api/admin/obligations', async (req) => ({
    items: deps.obligations.list({ status: req.query.status, userId: req.query.userId ? Number(req.query.userId) : undefined }),
  }));
  app.post<{ Body: CreateObligationRequest }>('/api/admin/obligations', async (req) => deps.obligations.create(req.body ?? ({} as CreateObligationRequest)));
  app.post<{ Params: { id: string }; Body: { comment?: string } }>('/api/admin/obligations/:id/write-off', async (req) =>
    deps.obligations.writeOff(Number(req.params.id), String(req.body?.comment ?? '')),
  );

  // ---------- Journal ----------

  app.get<{ Querystring: Record<string, string> }>('/api/admin/journal', async (req) => {
    const q = req.query ?? {};
    const num = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const query: JournalQuery = {
      types: q.types, q: q.q, userId: num(q.userId), dealId: num(q.dealId), from: num(q.from), to: num(q.to), before: num(q.before),
    };
    return { items: deps.audit.query(query) };
  });

  // ---------- Broadcasts ----------

  app.get('/api/admin/broadcasts', async () => ({ items: deps.broadcasts.list() }));
  app.get<{ Params: { id: string } }>('/api/admin/broadcasts/:id', async (req) => deps.broadcasts.get(Number(req.params.id)));
  app.post<{ Body: BroadcastRequest }>('/api/admin/broadcasts/test', { bodyLimit: PHOTO_BODY_LIMIT }, async (req) => deps.broadcasts.test(req.body ?? ({} as BroadcastRequest)));
  app.post<{ Body: BroadcastRequest & { confirm?: boolean } }>('/api/admin/broadcasts', { bodyLimit: PHOTO_BODY_LIMIT }, async (req) => {
    if (req.body?.confirm !== true) throw new AppError(400, 'confirm', 'Подтвердите отправку');
    return deps.broadcasts.start(req.body);
  });

  // ---------- МК: service orders ----------
  const ORDER_STATUSES: (OrderStatus | 'all')[] = ['pending', 'clarify', 'paid', 'rejected', 'all'];
  app.get<{ Querystring: { status?: string } }>('/api/admin/orders', async (req) => {
    const s = ORDER_STATUSES.includes(req.query.status as OrderStatus) ? (req.query.status as OrderStatus) : 'all';
    return { items: deps.orders.adminList(s), counts: deps.orders.counts() };
  });
  app.get<{ Params: { id: string } }>('/api/admin/orders/:id', async (req) => deps.orders.adminGet(Number(req.params.id)));
  const orderAction = (path: string, run: (id: number, body: Record<string, unknown>) => unknown) =>
    app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(`/api/admin/orders/:id/${path}`, async (req) => {
      const id = Number(req.params.id);
      run(id, req.body ?? {});
      return deps.orders.adminGet(id);
    });
  orderAction('paid', (id) => deps.orders.markPaid(id));
  orderAction('clarify', (id, b) => deps.orders.clarify(id, String(b.message ?? '')));
  orderAction('reject', (id, b) => deps.orders.reject(id, String(b.reason ?? '')));
  orderAction('note', (id, b) => deps.orders.addNote(id, String(b.text ?? '')));

  // ---------- Deposits (USDT TRC-20) ----------

  const DEPOSIT_STATUSES = ['held', 'below_min', 'pending', 'credited', 'rejected', 'failed', 'all'];
  app.get<{ Querystring: { status?: string } }>('/api/admin/deposits', async (req) => {
    const s = DEPOSIT_STATUSES.includes(req.query.status ?? '') ? req.query.status! : 'held';
    return { items: deps.deposits.adminList(s), counts: deps.deposits.adminCounts(), enabled: deps.deposits.enabled() };
  });
  app.post<{ Params: { id: string }; Body: { note?: string; userId?: number } }>('/api/admin/deposits/:id/credit', async (req) =>
    deps.deposits.creditByAdmin(Number(req.params.id), String(req.body?.note ?? ''), Number(req.body?.userId) || null),
  );
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/admin/deposits/:id/reject', async (req) =>
    deps.deposits.rejectByAdmin(Number(req.params.id), String(req.body?.reason ?? '')),
  );

  // USDT TRC-20 withdrawals sent by hand.
  app.get<{ Querystring: { status?: string } }>('/api/admin/usdt-withdrawals', async (req) => {
    const s = (['new', 'sent', 'rejected', 'all'] as const).find((x) => x === req.query.status) ?? 'new';
    return { items: deps.usdtPayouts.adminList(s), counts: deps.usdtPayouts.counts() };
  });
  app.post<{ Params: { id: string }; Body: { txId?: string; force?: boolean; note?: string } }>('/api/admin/usdt-withdrawals/:id/sent', async (req) =>
    deps.usdtPayouts.markSent(Number(req.params.id), String(req.body?.txId ?? ''), req.body?.force === true, String(req.body?.note ?? '')),
  );
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/admin/usdt-withdrawals/:id/reject', async (req) =>
    deps.usdtPayouts.reject(Number(req.params.id), String(req.body?.reason ?? '')),
  );

  // Deposit addresses (TronLink accounts) and the operator's own wallets.
  app.get('/api/admin/deposit-pool', async () => ({ items: deps.deposits.poolList() }));
  app.post<{ Body: { address?: string; label?: string; own?: boolean } }>('/api/admin/deposit-pool', async (req) => ({
    items: deps.deposits.poolAdd(String(req.body?.address ?? ''), String(req.body?.label ?? ''), !!req.body?.own),
  }));
  app.post<{ Params: { id: string }; Body: { enabled?: boolean; label?: string } }>('/api/admin/deposit-pool/:id', async (req) => ({
    items: deps.deposits.poolUpdate(Number(req.params.id), {
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
    }),
  }));
  app.post<{ Params: { id: string } }>('/api/admin/deposit-pool/:id/remove', async (req) => ({ items: deps.deposits.poolRemove(Number(req.params.id)) })); 

  // Manual screening: GET /api/admin/aml/check?chain=TRON&address=T...
  app.get<{ Querystring: { chain?: string; address?: string } }>('/api/admin/aml/check', async (req, reply) => {
    const { chain, address } = req.query;
    if (!chain || !CHAINS.includes(chain as Chain) || !address) {
      return reply.code(400).send({ error: 'chain (TRON|BSC|ETH|TON) and address are required' });
    }
    return deps.aml.screen(chain as Chain, address.trim());
  });
}
