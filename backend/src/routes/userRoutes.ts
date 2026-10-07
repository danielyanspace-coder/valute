import type { FastifyInstance } from 'fastify';
import type { CreateCheckRequest, CreateOrderRequest, CreateWithdrawalRequest, DepositInfoDto, FineLookupDto, HistoryItem, MeDto, NotificationDto, SendTransferRequest, ServicesConfigDto } from '../../../shared/api.js';
import type { DepositService } from '../deposits/depositService.js';
import { STEAM_MAX_RUB, STEAM_MIN_RUB, MAX_PARKING_RUB, MIN_PARKING_RUB } from '../../../shared/services.js';
import type { FineLookup } from '../orders/fineLookup.js';
import type { OrderService } from '../orders/orderService.js';
import type { UserRepo } from '../users/userRepo.js';
import type { TransferService } from '../transfers/transferService.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { RateService } from '../rates/rateService.js';
import type { ObligationService } from '../obligations/obligationService.js';
import type { WithdrawalService } from '../withdrawals/withdrawalService.js';

export interface UserRouteDeps {
  ledger: Ledger;
  withdrawals: WithdrawalService;
  notifications: NotificationService;
  rates: RateService;
  supportUsername: string;
  transfers: TransferService;
  botUsername: () => string;
  users: UserRepo;
  depositMinUsdt: number;
  deposits: DepositService;
  orders: OrderService;
  fineLookup: FineLookup;
  servicesDiscountPercent: number;
  obligations: ObligationService;
}

/** Routes for the Mini App. Registered inside a scope that already runs Telegram auth. */
export function userRoutes(app: FastifyInstance, deps: UserRouteDeps) {
  // "Contact support" lock: every action is refused; reading (and dismissing notifications) still works.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.url.startsWith('/api/notifications')) return;
    if (req.user && deps.withdrawals.contactLock(req.user.id)) {
      return reply.code(423).send({ error: 'locked', message: 'Действие недоступно. Свяжитесь с поддержкой' });
    }
  });

  app.get('/api/me', async (req): Promise<MeDto> => {
    const u = req.user!;
    return {
      user: {
        id: u.id,
        telegramId: u.telegram_id,
        username: u.username,
        firstName: u.first_name,
        lastName: u.last_name,
        photoUrl: u.photo_url,
      },
      ...deps.ledger.balances(u.id),
      blocked: !!u.blocked,
      supportUsername: deps.supportUsername,
      contactLock: deps.withdrawals.contactLock(u.id),
      botUsername: deps.botUsername(),
      stats: { ...deps.withdrawals.exchangeStats(u.id), memberSince: u.created_at },
    };
  });

  app.get('/api/withdrawals', async (req) => ({
    items: deps.withdrawals.listForUser(req.user!.id).map((w) => deps.withdrawals.toUserDto(w)),
  }));

  app.get<{ Params: { id: string } }>('/api/withdrawals/:id', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.getForUser(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Body: CreateWithdrawalRequest }>('/api/withdrawals', async (req) => {
    const rate = deps.rates.getWalletRate();
    // Withdrawals use the wallet's current rate, the same number the user sees on the home screen.
    const quote = rate ? { rate: rate.walletRate, exchangeRate: rate.exchangeAsk } : null;
    const w = deps.withdrawals.create(req.user!, req.body ?? ({} as CreateWithdrawalRequest), quote, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return deps.withdrawals.toUserDto(w);
  });

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/received', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userReceived(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/not-received', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userNotReceived(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Params: { id: string }; Body: { amountRub?: number } }>('/api/withdrawals/:id/other-amount', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userOtherAmount(req.user!.id, Number(req.params.id), Number(req.body?.amountRub))),
  );

  app.get('/api/notifications', async (req) => {
    const uid = req.user!.id;
    const items = deps.notifications.unseen(uid).map((n): NotificationDto => {
      const t = n.transferId ? deps.transfers.transfer(n.transferId) : undefined;
      const c = n.checkId ? deps.transfers.check(n.checkId) : undefined;
      const o = n.orderId ? deps.orders.row(n.orderId) : undefined;
      const d = n.depositId ? deps.deposits.get(n.depositId) : null;
      return {
        id: n.id,
        type: n.type,
        withdrawalId: n.withdrawalId,
        transfer: t ? deps.transfers.transferDto(t, uid) : null,
        check: c ? deps.transfers.checkDto(c) : null,
        order: o ? deps.orders.toUserDto(o) : null,
        deposit: d ? deps.deposits.toUserDto(d) : null,
        deduction: n.type === 'obligation_repaid' && n.obligationId
          ? { id: n.id, amountMicro: n.amountMicro ?? 0, reason: deps.obligations.get(n.obligationId).publicReason, createdAt: n.createdAt }
          : null,
        createdAt: n.createdAt,
      };
    });
    return { items };
  });

  // Deposits are USDT TRC-20 only, through a request: the user gets an address from the
  // pool for 15 minutes. A new request needs the old one cancelled.
  const depositInfo = (uid: number): DepositInfoDto => ({
    token: 'USDT',
    network: 'TRC20',
    networkName: 'TRON (TRC-20)',
    enabled: deps.deposits.enabled(),
    request: deps.deposits.current(uid),
    minDepositMicro: Math.round(deps.depositMinUsdt * 1_000_000),
    confirmations: 20,
  });
  app.get('/api/deposit', async (req) => depositInfo(req.user!.id));
  app.post('/api/deposit/request', async (req) => {
    deps.deposits.open(req.user!.id);
    return depositInfo(req.user!.id);
  });
  app.post('/api/deposit/request/cancel', async (req) => {
    deps.deposits.cancel(req.user!.id);
    return depositInfo(req.user!.id);
  });

  app.get('/api/history', async (req) => {
    const uid = req.user!.id;
    const orders = deps.orders.listForUser(uid).map((o): HistoryItem => ({ type: 'order', at: o.created_at, order: deps.orders.toUserDto(o) }));
    const deposits = deps.deposits.listForUser(uid).map((d): HistoryItem => {
      const deposit = deps.deposits.toUserDto(d);
      return { type: 'deposit', at: deposit.createdAt, deposit };
    });
    const deductions = deps.obligations.deductionsForUser(uid).map((deduction): HistoryItem => ({ type: 'deduction', at: deduction.createdAt, deduction }));
    return { items: [...deps.transfers.history(uid), ...orders, ...deposits, ...deductions].sort((a, b) => b.at - a.at).slice(0, 100) };
  });

  // ---------- Services: fines, parking, Steam ----------

  app.get('/api/services/config', async (_req, reply): Promise<ServicesConfigDto | void> => {
    const rate = deps.rates.getWalletRate();
    if (!rate) return reply.code(503).send({ error: 'rate_unavailable', message: 'Курс временно недоступен' });
    return {
      discountPercent: deps.servicesDiscountPercent,
      serviceRate: deps.orders.rateFor(rate.exchangeAsk),
      fineLookupAvailable: deps.fineLookup.available,
      steam: { minRub: STEAM_MIN_RUB, maxRub: STEAM_MAX_RUB },
      parking: { minRub: MIN_PARKING_RUB, maxRub: MAX_PARKING_RUB },
    };
  });

  app.get<{ Querystring: { uin?: string } }>('/api/fines/lookup', async (req): Promise<FineLookupDto> => {
    if (!deps.fineLookup.available) {
      return { found: false, manual: true, message: 'Введите сумму из постановления, мы проверим штраф перед оплатой' };
    }
    const fine = await deps.orders.lookupFine(req.query.uin ?? '');
    return fine ? { found: true, fine } : { found: false, manual: false, message: 'Штраф с таким УИН не найден или уже оплачен' };
  });

  app.post<{ Body: CreateOrderRequest & { platform?: string } }>('/api/orders', async (req) => {
    const rate = deps.rates.getWalletRate();
    const o = await deps.orders.create(req.user!, req.body ?? ({} as CreateOrderRequest), rate?.exchangeAsk ?? null, {
      ip: req.ip,
      platform: req.body?.platform,
    });
    return deps.orders.toUserDto(o);
  });

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) =>
    deps.orders.toUserDto(deps.orders.getForUser(req.user!.id, Number(req.params.id))),
  );

  app.get<{ Querystring: { username?: string } }>('/api/users/lookup', async (req) => {
    const u = deps.transfers.findRecipient(req.user!, req.query.username ?? '');
    return deps.transfers.person(u.id);
  });

  app.post<{ Body: SendTransferRequest }>('/api/transfers', async (req) => {
    const t = deps.transfers.sendDirect(req.user!, req.body ?? ({} as SendTransferRequest));
    return deps.transfers.transferDto(t, req.user!.id);
  });

  app.get('/api/checks', async (req) => ({ items: deps.transfers.checksOf(req.user!.id).map((c) => deps.transfers.checkDto(c)) }));

  app.post<{ Body: CreateCheckRequest }>('/api/checks', async (req) => {
    const b = req.body ?? ({} as CreateCheckRequest);
    return deps.transfers.checkDto(deps.transfers.createCheck(req.user!, { amount: b.amount, comment: b.comment, requestId: b.requestId }));
  });

  app.post<{ Params: { id: string } }>('/api/checks/:id/cancel', async (req) =>
    deps.transfers.checkDto(deps.transfers.cancelCheck(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Body: { ids?: number[] } }>('/api/notifications/seen', async (req) => {
    deps.notifications.markSeen(req.user!.id, (req.body?.ids ?? []).filter(Number.isInteger).slice(0, 100));
    return { ok: true };
  });
}
