import type { FastifyInstance } from 'fastify';
import type { CreateCheckRequest, CreateOrderRequest, CreateWithdrawalRequest, DepositInfoDto, FineLookupDto, HistoryItem, MeDto, NotificationDto, SendTransferRequest, ServicesConfigDto } from '../../../shared/api.js';
import type { DepositAddressService } from '../deposits/depositAddressService.js';
import { STEAM_MAX_RUB, STEAM_MIN_RUB, MAX_PARKING_RUB, MIN_PARKING_RUB } from '../../../shared/services.js';
import type { FineLookup } from '../orders/fineLookup.js';
import type { OrderService } from '../orders/orderService.js';
import type { UserRepo } from '../users/userRepo.js';
import type { TransferService } from '../transfers/transferService.js';
import type { Ledger } from '../ledger/ledger.js';
import type { NotificationService } from '../notifications/notificationService.js';
import type { RateService } from '../rates/rateService.js';
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
  /** null until TRON_XPUB is configured. */
  depositAddresses: DepositAddressService | null;
  orders: OrderService;
  fineLookup: FineLookup;
  servicesDiscountPercent: number;
}

/** Routes for the Mini App. Registered inside a scope that already runs Telegram auth. */
export function userRoutes(app: FastifyInstance, deps: UserRouteDeps) {
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

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/confirm', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.confirmByUser(req.user!.id, Number(req.params.id))),
  );

  app.post<{ Params: { id: string } }>('/api/withdrawals/:id/dispute', async (req) =>
    deps.withdrawals.toUserDto(deps.withdrawals.disputeByUser(req.user!.id, Number(req.params.id))),
  );

  app.get('/api/notifications', async (req) => {
    const uid = req.user!.id;
    const items = deps.notifications.unseen(uid).map((n): NotificationDto => {
      const t = n.transferId ? deps.transfers.transfer(n.transferId) : undefined;
      const c = n.checkId ? deps.transfers.check(n.checkId) : undefined;
      const o = n.orderId ? deps.orders.row(n.orderId) : undefined;
      return {
        id: n.id,
        type: n.type,
        withdrawalId: n.withdrawalId,
        transfer: t ? deps.transfers.transferDto(t, uid) : null,
        check: c ? deps.transfers.checkDto(c) : null,
        order: o ? deps.orders.toUserDto(o) : null,
        createdAt: n.createdAt,
      };
    });
    return { items };
  });

  // Deposits are USDT TRC-20 only. The address is issued on the first visit of the deposit
  // screen; without TRON_XPUB the app shows "address is being prepared".
  app.get('/api/deposit', async (req): Promise<DepositInfoDto> => {
    const uid = req.user!.id;
    const tron = deps.depositAddresses
      ? { address: deps.depositAddresses.forUser(uid) }
      : deps.users.depositAddresses(uid).find((a) => a.chain === 'TRON');
    return {
      token: 'USDT',
      network: 'TRC20',
      networkName: 'TRON (TRC-20)',
      address: tron?.address ?? null,
      minDepositMicro: Math.round(deps.depositMinUsdt * 1_000_000),
      confirmations: 20,
    };
  });

  app.get('/api/history', async (req) => {
    const uid = req.user!.id;
    const orders = deps.orders.listForUser(uid).map((o): HistoryItem => ({ type: 'order', at: o.created_at, order: deps.orders.toUserDto(o) }));
    return { items: [...deps.transfers.history(uid), ...orders].sort((a, b) => b.at - a.at).slice(0, 100) };
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
