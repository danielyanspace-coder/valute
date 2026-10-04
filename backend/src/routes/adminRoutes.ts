import type { FastifyInstance } from 'fastify';
import type { WithdrawalStatus } from '../../../shared/payout.js';
import { USDT_MICRO } from '../../../shared/payout.js';
import type { AmlService } from '../aml/amlService.js';
import type { Chain } from '../aml/types.js';
import type { UserRepo } from '../users/userRepo.js';
import type { OrderService } from '../orders/orderService.js';
import type { DepositService } from '../deposits/depositService.js';
import { AppError } from '../withdrawals/withdrawalService.js';
import type { OrderStatus } from '../../../shared/services.js';
import type { WithdrawalService } from '../withdrawals/withdrawalService.js';

const CHAINS: Chain[] = ['TRON', 'BSC', 'ETH', 'TON'];
const STATUSES: (WithdrawalStatus | 'all')[] = ['pending', 'sent', 'disputed', 'completed', 'rejected', 'all'];

export interface AdminRouteDeps {
  withdrawals: WithdrawalService;
  users: UserRepo;
  aml: AmlService;
  orders: OrderService;
  deposits: DepositService | null;
}

/** Routes for the admin panel. Registered inside a scope that already checks the admin token. */
export function adminRoutes(app: FastifyInstance, deps: AdminRouteDeps) {
  const { withdrawals } = deps;

  app.get<{ Querystring: { status?: string } }>('/api/admin/withdrawals', async (req) => {
    const status = STATUSES.includes(req.query.status as WithdrawalStatus) ? (req.query.status as WithdrawalStatus) : 'all';
    return { items: withdrawals.adminList(status), counts: withdrawals.counts() };
  });

  app.get<{ Params: { id: string } }>('/api/admin/withdrawals/:id', async (req) => withdrawals.adminGet(Number(req.params.id)));

  const action = (path: string, run: (id: number, body: Record<string, unknown>) => unknown) =>
    app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(`/api/admin/withdrawals/:id/${path}`, async (req) => {
      const id = Number(req.params.id);
      run(id, req.body ?? {});
      return withdrawals.adminGet(id);
    });

  action('mark-sent', (id) => withdrawals.markSent(id));
  action('confirm', (id) => withdrawals.confirmByAdmin(id));
  action('reject', (id, b) => withdrawals.reject(id, String(b.reason ?? '')));
  action('request-contact', (id) => withdrawals.requestContact(id));
  action('note', (id, b) => withdrawals.addNote(id, String(b.text ?? '')));

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
  const depositsOrFail = () => {
    if (!deps.deposits) throw new AppError(503, 'deposits_off', 'Пополнения не настроены (нет TRON_XPUB)');
    return deps.deposits;
  };
  app.get<{ Querystring: { status?: string } }>('/api/admin/deposits', async (req) => {
    if (!deps.deposits) return { items: [], counts: { held: 0, below_min: 0, pending: 0, credited: 0, rejected: 0 }, enabled: false };
    const s = DEPOSIT_STATUSES.includes(req.query.status ?? '') ? req.query.status! : 'held';
    return { items: deps.deposits.adminList(s), counts: deps.deposits.adminCounts(), enabled: true };
  });
  app.post<{ Params: { id: string }; Body: { note?: string } }>('/api/admin/deposits/:id/credit', async (req) =>
    depositsOrFail().creditByAdmin(Number(req.params.id), String(req.body?.note ?? '')),
  );
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/admin/deposits/:id/reject', async (req) =>
    depositsOrFail().rejectByAdmin(Number(req.params.id), String(req.body?.reason ?? '')),
  );

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => withdrawals.adminUser(Number(req.params.id)));

  app.post<{ Params: { id: string }; Body: { amountUsdt?: number; comment?: string } }>(
    '/api/admin/users/:id/adjust',
    async (req) => {
      const id = Number(req.params.id);
      withdrawals.adjustBalance(id, Math.round(Number(req.body?.amountUsdt) * USDT_MICRO), String(req.body?.comment ?? ''));
      return withdrawals.adminUser(id);
    },
  );

  app.post<{ Params: { id: string }; Body: { blocked?: boolean } }>('/api/admin/users/:id/block', async (req) => {
    const id = Number(req.params.id);
    deps.users.setBlocked(id, !!req.body?.blocked);
    return withdrawals.adminUser(id);
  });

  // Manual screening: GET /api/admin/aml/check?chain=TRON&address=T...
  app.get<{ Querystring: { chain?: string; address?: string } }>('/api/admin/aml/check', async (req, reply) => {
    const { chain, address } = req.query;
    if (!chain || !CHAINS.includes(chain as Chain) || !address) {
      return reply.code(400).send({ error: 'chain (TRON|BSC|ETH|TON) and address are required' });
    }
    return deps.aml.screen(chain as Chain, address.trim());
  });
}
