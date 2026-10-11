import type { FastifyInstance } from 'fastify';
import type { BuyPremiumRequest, CreateCheckRequest, CreateOrderRequest, CreateUsdtPayoutRequest, CreateWithdrawalRequest, DepositInfoDto, FineLookupDto, HistoryItem, MeDto, NotificationDto, SendTransferRequest, ServicesConfigDto } from '../../../shared/api.js';
import type { DepositService } from '../deposits/depositService.js';
import type { UsdtPayoutService } from '../usdtPayouts/usdtPayoutService.js';
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
import type { PremiumService } from '../premium/premiumService.js';
import type { GiveawayService } from '../giveaways/giveawayService.js';

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
  usdtPayouts: UsdtPayoutService;
  orders: OrderService;
  fineLookup: FineLookup;
  servicesDiscountPercent: number;
  obligations: ObligationService;
  premium: PremiumService;
  giveaways: GiveawayService;
}

/** Routes for the Mini App. Registered inside a scope that already runs Telegram auth. */
export function userRoutes(app: FastifyInstance, deps: UserRouteDeps) {
  // "Contact support" lock: every action is refused; reading (and dismissing notifications) still works.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' || req.url.startsWith('/api/notifications')) return;
    if (req.user && deps.withdrawals.contactLock(req.user.id)) {
      return reply.code(423).send({ error: 'locked', message: 'Действие недоступно. Свяжитесь с поддержкой' });
    }
    // An expired deal: only the answer itself is allowed.
    const lock = req.user ? deps.withdrawals.answerLock(req.user.id) : null;
    if (lock && !/^\/api\/withdrawals\/\d+\/(received|not-received|other-amount)$/.test(req.url.split('?')[0])) {
      return reply.code(423).send({ error: 'answer_required', message: `Сначала ответьте по заявке №${lock.withdrawalId}: поступила ли оплата` });
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
      answerLock: deps.withdrawals.answerLock(u.id),
      usdtPayout: { feeMicro: deps.usdtPayouts.opts.feeMicro, minMicro: deps.usdtPayouts.opts.minMicro },
      botUsername: deps.botUsername(),
      stats: { ...deps.withdrawals.exchangeStats(u.id), memberSince: u.created_at },
      premium: (() => {
        const until = deps.premium.until(u.id);
        return until ? { until } : null;
      })(),
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

  // USDT TRC-20 to an external wallet: a request the operator sends by hand.
  app.get<{ Params: { id: string } }>('/api/usdt-withdrawals/:id', async (req) =>
    deps.usdtPayouts.toUserDto(deps.usdtPayouts.getForUser(req.user!.id, Number(req.params.id))),
  );
  app.post<{ Body: CreateUsdtPayoutRequest }>('/api/usdt-withdrawals', async (req) =>
    deps.usdtPayouts.toUserDto(await deps.usdtPayouts.create(req.user!, req.body ?? ({} as CreateUsdtPayoutRequest), { ip: req.ip })),
  );

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/received', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userReceived(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/not-received', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userNotReceived(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/not-yet', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userNotYet(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Params: { id: string }; Body: { amountRub?: number } }>('/api/withdrawals/:id/other-amount', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.userOtherAmount(req.user!.id, Number(req.params.id), Number(req.body?.amountRub))),
  );

  // IX Black: paid status bought from the balance.
  app.get('/api/premium', async (req) => deps.premium.status(req.user!.id));
  app.post<{ Body: BuyPremiumRequest }>('/api/premium/buy', async (req) => deps.premium.buy(req.user!, req.body ?? ({} as BuyPremiumRequest)));

  // Free giveaways: one tap to join, nothing to pay.
  app.get('/api/giveaways/current', async (req) => ({ giveaway: deps.giveaways.current(req.user!.id) }));
  app.post<{ Params: { id: string } }>('/api/giveaways/:id/join', async (req) => deps.giveaways.join(req.user!, Number(req.params.id)));

  app.get('/api/notifications', async (req) => {
    const uid = req.user!.id;
    const items = deps.notifications.unseen(uid).map((n): NotificationDto => {
      const t = n.transferId ? deps.transfers.transfer(n.transferId) : undefined;
      const c = n.checkId ? deps.transfers.check(n.checkId) : undefined;
      const o = n.orderId ? deps.orders.row(n.orderId) : undefined;
      const d = n.depositId ? deps.deposits.get(n.depositId) : null;
      const up = n.usdtPayoutId ? deps.usdtPayouts.get(n.usdtPayoutId) : null;
      return {
        id: n.id,
        type: n.type,
        withdrawalId: n.withdrawalId,
        transfer: t ? deps.transfers.transferDto(t, uid) : null,
        check: c ? deps.transfers.checkDto(c) : null,
        order: o ? deps.orders.toUserDto(o) : null,
        deposit: d ? deps.deposits.toUserDto(d) : null,
        usdtPayout: up ? deps.usdtPayouts.toUserDto(up) : null,
        deduction: n.type === 'obligation_repaid' && n.obligationId
          ? { id: n.id, amountMicro: n.amountMicro ?? 0, reason: deps.obligations.get(n.obligationId).publicReason, createdAt: n.createdAt }
          : null,
        amountMicro: n.type === 'premium_cashback' || n.type === 'giveaway_won' ? n.amountMicro : null,
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
    const payouts = deps.usdtPayouts.listForUser(uid).map((p): HistoryItem => ({ type: 'usdt_payout', at: p.created_at, usdtPayout: deps.usdtPayouts.toUserDto(p) }));
    const bonuses = deps.premium.history(uid).map((b): HistoryItem => ({ type: 'bonus', ...b }));
    return { items: [...deps.transfers.history(uid), ...orders, ...deposits, ...deductions, ...payouts, ...bonuses].sort((a, b) => b.at - a.at).slice(0, 100) };
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

  // Capped so the user base cannot be enumerated by username.
  app.get<{ Querystring: { username?: string } }>('/api/users/lookup', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
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
