import type { FastifyInstance } from 'fastify';
import type { CreateWithdrawalRequest, MeDto } from '../../../shared/api.js';
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
    const quote = rate ? { sellRate: rate.sellRate, exchangeBid: rate.exchangeBid } : null;
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

  app.get('/api/notifications', async (req) => ({ items: deps.notifications.unseen(req.user!.id) }));

  app.post<{ Body: { ids?: number[] } }>('/api/notifications/seen', async (req) => {
    deps.notifications.markSeen(req.user!.id, (req.body?.ids ?? []).filter(Number.isInteger).slice(0, 100));
    return { ok: true };
  });
}
