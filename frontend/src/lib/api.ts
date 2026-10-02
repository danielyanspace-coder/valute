import type {
  AdminCounts,
  AdminUserDto,
  AdminWithdrawalDto,
  AdminWithdrawalListItem,
  CreateWithdrawalRequest,
  MeDto,
  NotificationDto,
  WithdrawalDto,
} from '../../../shared/api';
import type { WithdrawalStatus } from '../../../shared/payout';
import { tg } from './telegram';

export interface RatePoint {
  t: number;
  v: number;
}

export interface WalletRate {
  pair: 'USDT/RUB';
  /** RUB per 1 USDT when buying, shown on the home screen. */
  buyRate: number;
  /** RUB per 1 USDT when the user spends USDT for rubles (SBP payments, card payouts). */
  sellRate: number;
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
  confirmWithdrawal(id: number): Promise<WithdrawalDto>;
  disputeWithdrawal(id: number): Promise<WithdrawalDto>;
  notifications(): Promise<{ items: NotificationDto[] }>;
  markNotificationsSeen(ids: number[]): Promise<unknown>;
}

export interface AdminApi {
  list(status: WithdrawalStatus | 'all'): Promise<{ items: AdminWithdrawalListItem[]; counts: AdminCounts }>;
  get(id: number): Promise<AdminWithdrawalDto>;
  markSent(id: number): Promise<AdminWithdrawalDto>;
  confirm(id: number): Promise<AdminWithdrawalDto>;
  reject(id: number, reason: string): Promise<AdminWithdrawalDto>;
  requestContact(id: number): Promise<AdminWithdrawalDto>;
  note(id: number, text: string): Promise<AdminWithdrawalDto>;
  adjustBalance(userId: number, amountUsdt: number, comment: string): Promise<AdminUserDto>;
  setBlocked(userId: number, blocked: boolean): Promise<AdminUserDto>;
}

async function request<T>(method: string, path: string, auth: string | undefined, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? 'error', err.message ?? 'Не удалось выполнить запрос, попробуйте ещё раз');
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
  confirmWithdrawal: (id) => request('POST', `/api/withdrawals/${id}/confirm`, userAuth(), {}),
  disputeWithdrawal: (id) => request('POST', `/api/withdrawals/${id}/dispute`, userAuth(), {}),
  notifications: () => request('GET', '/api/notifications', userAuth()),
  markNotificationsSeen: (ids) => request('POST', '/api/notifications/seen', userAuth(), { ids }),
};

export function httpAdminApi(token: string): AdminApi {
  const auth = `Bearer ${token}`;
  const post = <T>(path: string, body: unknown = {}) => request<T>('POST', `/api/admin${path}`, auth, body);
  return {
    list: (status) => request('GET', `/api/admin/withdrawals?status=${status}`, auth),
    get: (id) => request('GET', `/api/admin/withdrawals/${id}`, auth),
    markSent: (id) => post(`/withdrawals/${id}/mark-sent`),
    confirm: (id) => post(`/withdrawals/${id}/confirm`),
    reject: (id, reason) => post(`/withdrawals/${id}/reject`, { reason }),
    requestContact: (id) => post(`/withdrawals/${id}/request-contact`),
    note: (id, text) => post(`/withdrawals/${id}/note`, { text }),
    adjustBalance: (userId, amountUsdt, comment) => post(`/users/${userId}/adjust`, { amountUsdt, comment }),
    setBlocked: (userId, blocked) => post(`/users/${userId}/block`, { blocked }),
  };
}

export const IS_DEMO = import.meta.env.MODE === 'demo';
