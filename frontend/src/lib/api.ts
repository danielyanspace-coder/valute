import type {
  AdminGiveawayDto,
  AdminPremiumDto,
  CreateGiveawayRequest,
  GiveawayDto,
  PremiumStatusDto,
  AdminAuditItem,
  AdminBoardDto,
  AdminBroadcastDto,
  AdminDepositAddressDto,
  AdminStatsDto,
  AdminUsdtPayoutCounts,
  AdminUsdtPayoutDto,
  CreateUsdtPayoutRequest,
  UsdtPayoutDto,
  AdminDepositCounts,
  AdminDepositDto,
  AdminObligationDto,
  AdminOrderCounts,
  AdminOrderDto,
  AdminOrderListItem,
  AdminUserListItem,
  AdminUserPageDto,
  AdminWalletBalancesDto,
  AdminWithdrawalDto,
  AdminWithdrawalListItem,
  ArchiveQuery,
  BroadcastRequest,
  CheckDto,
  CreateCheckRequest,
  CreateObligationRequest,
  CreateOrderRequest,
  CreateWithdrawalRequest,
  DepositInfoDto,
  FineLookupDto,
  HistoryItem,
  JournalQuery,
  MeDto,
  NotificationDto,
  PersonDto,
  SendTransferRequest,
  ServiceOrderDto,
  ServicesConfigDto,
  TransferDto,
  WithdrawalDto,
} from '../../../shared/api';
import type { OrderStatus } from '../../../shared/services';
import { tg } from './telegram';

export interface RatePoint {
  t: number;
  v: number;
}

export interface WalletRate {
  pair: 'USDT/RUB';
  /** The wallet's current rate: shown on the home screen and used for ruble withdrawals. */
  walletRate: number;
  /** Rate for paying SBP QR codes from the balance. */
  qrPayRate: number;
  change24hPercent: number;
  history: RatePoint[];
  updatedAt: number;
}

export interface MarketCoin {
  symbol: string;
  priceUsd: number;
  change24hPercent: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields of the error body (e.g. retryAt for pool_busy). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Api {
  rate(): Promise<WalletRate>;
  market(): Promise<{ coins: MarketCoin[] }>;
  me(): Promise<MeDto>;
  withdrawals(): Promise<{ items: WithdrawalDto[] }>;
  withdrawal(id: number): Promise<WithdrawalDto>;
  createWithdrawal(req: CreateWithdrawalRequest): Promise<WithdrawalDto>;
  createUsdtPayout(req: CreateUsdtPayoutRequest): Promise<UsdtPayoutDto>;
  usdtPayout(id: number): Promise<UsdtPayoutDto>;
  dealReceived(id: number): Promise<WithdrawalDto>;
  dealNotReceived(id: number): Promise<WithdrawalDto>;
  /** "Not yet" under reminders 1-4: changes nothing, marks the user as responsive. */
  dealNotYet(id: number): Promise<WithdrawalDto>;
  dealOtherAmount(id: number, amountRub: number): Promise<WithdrawalDto>;
  notifications(): Promise<{ items: NotificationDto[] }>;
  markNotificationsSeen(ids: number[]): Promise<unknown>;
  history(): Promise<{ items: HistoryItem[] }>;
  deposit(): Promise<DepositInfoDto>;
  depositOpen(): Promise<DepositInfoDto>;
  depositCancel(): Promise<DepositInfoDto>;
  lookupUser(username: string): Promise<PersonDto>;
  sendTransfer(req: SendTransferRequest): Promise<TransferDto>;
  checks(): Promise<{ items: CheckDto[] }>;
  createCheck(req: CreateCheckRequest): Promise<CheckDto>;
  cancelCheck(id: number): Promise<CheckDto>;
  servicesConfig(): Promise<ServicesConfigDto>;
  lookupFine(uin: string): Promise<FineLookupDto>;
  createOrder(req: CreateOrderRequest & { platform?: string }): Promise<ServiceOrderDto>;
  order(id: number): Promise<ServiceOrderDto>;
  premium(): Promise<PremiumStatusDto>;
  buyPremium(plan: string, requestId: string): Promise<PremiumStatusDto>;
  giveaway(): Promise<{ giveaway: GiveawayDto | null }>;
  joinGiveaway(id: number): Promise<GiveawayDto>;
  /** Demo only: pretend a friend pressed "Получить" on the check. */
  demoClaimCheck?(code: string): Promise<unknown>;
}

export type DealActionPath =
  | 'take'
  | 'entered'
  | 'requisite-off'
  | 'confirm'
  | 'close'
  | 'reopen'
  | 'accept-correction'
  | 'accept-original'
  | 'cancel'
  | 'external-id'
  | 'note';

export interface AdminApi {
  premium(): Promise<AdminPremiumDto>;
  giveaways(): Promise<{ items: AdminGiveawayDto[] }>;
  giveawayCreate(req: CreateGiveawayRequest): Promise<AdminGiveawayDto>;
  giveawayDraw(id: number): Promise<AdminGiveawayDto>;
  giveawayCancel(id: number): Promise<AdminGiveawayDto>;
  board(): Promise<AdminBoardDto>;
  archive(q: ArchiveQuery): Promise<{ items: AdminWithdrawalListItem[] }>;
  deal(id: number): Promise<AdminWithdrawalDto>;
  dealAction(id: number, action: DealActionPath, body?: Record<string, unknown>): Promise<AdminWithdrawalDto>;
  users(q: string): Promise<{ items: AdminUserListItem[] }>;
  user(id: number): Promise<AdminUserPageDto>;
  adjustBalance(userId: number, amountUsdt: number, comment: string): Promise<AdminUserPageDto>;
  setBlocked(userId: number, blocked: boolean): Promise<AdminUserPageDto>;
  setSupportLock(userId: number, locked: boolean): Promise<AdminUserPageDto>;
  obligations(f: { status?: string; userId?: number }): Promise<{ items: AdminObligationDto[] }>;
  createObligation(req: CreateObligationRequest): Promise<AdminObligationDto>;
  writeOffObligation(id: number, comment: string): Promise<AdminObligationDto>;
  journal(q: JournalQuery): Promise<{ items: AdminAuditItem[] }>;
  broadcasts(): Promise<{ items: AdminBroadcastDto[] }>;
  broadcastTest(req: BroadcastRequest): Promise<{ ok: boolean; error: string | null }>;
  broadcastSend(req: BroadcastRequest): Promise<AdminBroadcastDto>;
  orders(status: OrderStatus | 'all'): Promise<{ items: AdminOrderListItem[]; counts: AdminOrderCounts }>;
  orderGet(id: number): Promise<AdminOrderDto>;
  orderPaid(id: number): Promise<AdminOrderDto>;
  orderClarify(id: number, message: string): Promise<AdminOrderDto>;
  orderReject(id: number, reason: string): Promise<AdminOrderDto>;
  orderNote(id: number, text: string): Promise<AdminOrderDto>;
  deposits(status: string): Promise<{ items: AdminDepositDto[]; counts: AdminDepositCounts; enabled: boolean }>;
  depositCredit(id: number, note: string, userId?: number): Promise<AdminDepositDto>;
  depositReject(id: number, reason: string): Promise<AdminDepositDto>;
  stats(): Promise<AdminStatsDto>;
  usdtPayouts(status: string): Promise<{ items: AdminUsdtPayoutDto[]; counts: AdminUsdtPayoutCounts }>;
  usdtPayoutSent(id: number, txId: string, force: boolean, note: string): Promise<AdminUsdtPayoutDto>;
  usdtPayoutReject(id: number, reason: string): Promise<AdminUsdtPayoutDto>;
  depositPool(): Promise<{ items: AdminDepositAddressDto[] }>;
  /** Live USDT/TRX on every pool address and own wallet; refresh bypasses the 1-minute cache. */
  walletBalances(refresh?: boolean): Promise<AdminWalletBalancesDto>;
  depositPoolAdd(address: string, label: string, own: boolean): Promise<{ items: AdminDepositAddressDto[] }>;
  depositPoolUpdate(id: number, patch: { enabled?: boolean; label?: string }): Promise<{ items: AdminDepositAddressDto[] }>;
  depositPoolRemove(id: number): Promise<{ items: AdminDepositAddressDto[] }>;
}

const qs = (o: object) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

async function request<T>(method: string, path: string, auth: string | undefined, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? 'Не удалось выполнить запрос, попробуйте ещё раз', err);
  }
  return res.json() as Promise<T>;
}

const userAuth = () => (tg?.initData ? `tma ${tg.initData}` : undefined);

export const httpApi: Api = {
  rate: () => request('GET', '/api/rate', undefined),
  market: () => request('GET', '/api/market', undefined),
  me: () => request('GET', '/api/me', userAuth()),
  withdrawals: () => request('GET', '/api/withdrawals', userAuth()),
  withdrawal: (id) => request('GET', `/api/withdrawals/${id}`, userAuth()),
  createWithdrawal: (req) => request('POST', '/api/withdrawals', userAuth(), req),
  createUsdtPayout: (req) => request('POST', '/api/usdt-withdrawals', userAuth(), req),
  usdtPayout: (id) => request('GET', `/api/usdt-withdrawals/${id}`, userAuth()),
  dealReceived: (id) => request('POST', `/api/withdrawals/${id}/received`, userAuth(), {}),
  dealNotReceived: (id) => request('POST', `/api/withdrawals/${id}/not-received`, userAuth(), {}),
  dealNotYet: (id) => request('POST', `/api/withdrawals/${id}/not-yet`, userAuth(), {}),
  dealOtherAmount: (id, amountRub) => request('POST', `/api/withdrawals/${id}/other-amount`, userAuth(), { amountRub }),
  notifications: () => request('GET', '/api/notifications', userAuth()),
  markNotificationsSeen: (ids) => request('POST', '/api/notifications/seen', userAuth(), { ids }),
  history: () => request('GET', '/api/history', userAuth()),
  premium: () => request('GET', '/api/premium', userAuth()),
  buyPremium: (plan, requestId) => request('POST', '/api/premium/buy', userAuth(), { plan, requestId }),
  giveaway: () => request('GET', '/api/giveaways/current', userAuth()),
  joinGiveaway: (id) => request('POST', `/api/giveaways/${id}/join`, userAuth(), {}),
  deposit: () => request('GET', '/api/deposit', userAuth()),
  depositOpen: () => request('POST', '/api/deposit/request', userAuth(), {}),
  depositCancel: () => request('POST', '/api/deposit/request/cancel', userAuth(), {}),
  lookupUser: (username) => request('GET', `/api/users/lookup?username=${encodeURIComponent(username)}`, userAuth()),
  sendTransfer: (req) => request('POST', '/api/transfers', userAuth(), req),
  checks: () => request('GET', '/api/checks', userAuth()),
  createCheck: (req) => request('POST', '/api/checks', userAuth(), req),
  cancelCheck: (id) => request('POST', `/api/checks/${id}/cancel`, userAuth(), {}),
  servicesConfig: () => request('GET', '/api/services/config', userAuth()),
  lookupFine: (uin) => request('GET', `/api/fines/lookup?uin=${encodeURIComponent(uin)}`, userAuth()),
  createOrder: (req) => request('POST', '/api/orders', userAuth(), req),
  order: (id) => request('GET', `/api/orders/${id}`, userAuth()),
};

export function httpAdminApi(token: string): AdminApi {
  const auth = `Bearer ${token}`;
  const post = <T>(path: string, body: unknown = {}) => request<T>('POST', `/api/admin${path}`, auth, body);
  return {
    board: () => request('GET', '/api/admin/deals/board', auth),
    archive: (q) => request('GET', `/api/admin/deals/archive?${qs(q)}`, auth),
    deal: (id) => request('GET', `/api/admin/deals/${id}`, auth),
    dealAction: (id, action, body = {}) => post(`/deals/${id}/${action}`, body),
    users: (q) => request('GET', `/api/admin/users?${qs({ q })}`, auth),
    user: (id) => request('GET', `/api/admin/users/${id}`, auth),
    adjustBalance: (userId, amountUsdt, comment) => post(`/users/${userId}/adjust`, { amountUsdt, comment }),
    setBlocked: (userId, blocked) => post(`/users/${userId}/block`, { blocked }),
    setSupportLock: (userId, locked) => post(`/users/${userId}/support-lock`, { locked }),
    obligations: (f) => request('GET', `/api/admin/obligations?${qs(f)}`, auth),
    createObligation: (req) => post('/obligations', req),
    writeOffObligation: (id, comment) => post(`/obligations/${id}/write-off`, { comment }),
    journal: (q) => request('GET', `/api/admin/journal?${qs(q)}`, auth),
    broadcasts: () => request('GET', '/api/admin/broadcasts', auth),
    broadcastTest: (req) => post('/broadcasts/test', req),
    broadcastSend: (req) => post('/broadcasts', { ...req, confirm: true }),
    orders: (status) => request('GET', `/api/admin/orders?status=${status}`, auth),
    orderGet: (id) => request('GET', `/api/admin/orders/${id}`, auth),
    orderPaid: (id) => post(`/orders/${id}/paid`),
    orderClarify: (id, message) => post(`/orders/${id}/clarify`, { message }),
    orderReject: (id, reason) => post(`/orders/${id}/reject`, { reason }),
    orderNote: (id, text) => post(`/orders/${id}/note`, { text }),
    deposits: (status) => request('GET', `/api/admin/deposits?status=${status}`, auth),
    depositCredit: (id, note, userId) => post(`/deposits/${id}/credit`, { note, userId }),
    stats: () => request('GET', '/api/admin/stats', auth),
    usdtPayouts: (status) => request('GET', `/api/admin/usdt-withdrawals?status=${status}`, auth),
    usdtPayoutSent: (id, txId, force, note) => post(`/usdt-withdrawals/${id}/sent`, { txId, force, note }),
    usdtPayoutReject: (id, reason) => post(`/usdt-withdrawals/${id}/reject`, { reason }),
    depositPool: () => request('GET', '/api/admin/deposit-pool', auth),
    walletBalances: (refresh = false) => request('GET', `/api/admin/deposit-pool/balances${refresh ? '?refresh=1' : ''}`, auth),
    depositPoolAdd: (address, label, own) => post('/deposit-pool', { address, label, own }),
    depositPoolUpdate: (id, patch) => post(`/deposit-pool/${id}`, patch),
    depositPoolRemove: (id) => post(`/deposit-pool/${id}/remove`),
    premium: () => request('GET', '/api/admin/premium', auth),
    giveaways: () => request('GET', '/api/admin/giveaways', auth),
    giveawayCreate: (req) => post('/giveaways', req),
    giveawayDraw: (id) => post(`/giveaways/${id}/draw`),
    giveawayCancel: (id) => post(`/giveaways/${id}/cancel`),
    depositReject: (id, reason) => post(`/deposits/${id}/reject`, { reason }),
  };
}

export const IS_DEMO = import.meta.env.MODE === 'demo';
