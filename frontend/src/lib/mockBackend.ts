// In-browser stand-in for the backend, used only by the standalone demo build.
// Mirrors the server rules (shared/payout.ts) so the whole flow, admin side
// included, can be clicked through without a server or Telegram.
import type {
  AdminDepositAddressDto,
  AdminStatsDto,
  AdminStatsPeriod,
  AdminUsdtPayoutDto,
  UsdtPayoutDto,
  AdminDepositCounts,
  DepositInfoDto,
  DepositRequestDto,
  AdminDepositDto,
  DepositDto,
  AdminOrderCounts,
  AdminOrderDto,
  AdminOrderListItem,
  CheckDto,
  ServiceOrderDto,
  CreateWithdrawalRequest,
  HistoryItem,
  PersonDto,
  TransferDto,
  MeDto,
  NotificationDto,
  NotificationType,
  WithdrawalDto,
  WithdrawalEventDto,
} from '../../../shared/api';
import {
  USDT_MICRO,
} from '../../../shared/payout';
import { findBank } from '../../../shared/sbpBanks';
import { validateUsdtPayout, type UsdtPayoutStatus } from '../../../shared/usdtPayout';
import { DEPOSIT_QUARANTINE_MS, DEPOSIT_REQUEST_TTL_MS, type DepositRequestStatus } from '../../../shared/deposits';
import { checkLink, cleanComment, isValidUsername, normalizeUsername, parseUsdt } from '../../../shared/transfers';
import {
  SERVICE_TITLE, STEAM_MAX_RUB, STEAM_MIN_RUB, MAX_PARKING_RUB, MIN_PARKING_RUB, fineDueRub, formatParkingPhone, nextOrderStatus,
  normalizeParkingPhone, normalizeUin, rubForServiceMicro, serviceMicroForRub, serviceRate, validateParkingAmount,
  validateParkingPhone, validateSteamLogin, validateSteamRub, validateUin, type FineInfo, type OrderAction, type OrderStatus,
  type ServiceKind,
} from '../../../shared/services';
import { ApiError, type AdminApi, type Api, type MarketCoin, type WalletRate } from './api';
import { createDealEngine, type DemoUser } from './mockDeals';

type MockUser = DemoUser;

const fail = (status: number, message: string): never => {
  throw new ApiError(status, 'demo', message);
};
const SENDER_ANN = 'TJW8kqZ3vHcN1mP6sYb2XgD9fJ4tLa7uEe';
const SENDER_IVAN = 'TKr8wqZ3vHcN1mP6sYb2XgD9fJ4tLa7uEe';
const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 180));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function createMockBackend(snapshot: { rate: WalletRate; coins: MarketCoin[] }) {
  const now = () => Date.now();
  let eventId = 1;
  let notificationId = 1;
  const t0 = now();

  const users: MockUser[] = [
    {
      id: 1, telegramId: 5_210_448_301, username: 'darkfox_ix', firstName: 'DarkFox', lastName: null, languageCode: 'ru',
      createdAt: t0 - 21 * DAY, lastSeenAt: t0, blocked: false, missedConfirmations: 0, supportLockedAt: null, botBlockedAt: null,
      availableMicro: 250 * USDT_MICRO, frozenMicro: 0, depositedMicro: 400 * USDT_MICRO,
      senderWallets: [{ address: SENDER_ANN, deposits: 2, lastAt: t0 - 6 * DAY }],
    },
    {
      id: 2, telegramId: 6_031_877_412, username: null, firstName: 'Иван', lastName: 'К.', languageCode: 'ru',
      createdAt: t0 - 4 * DAY, lastSeenAt: t0 - 12 * MIN, blocked: false, missedConfirmations: 2, supportLockedAt: null, botBlockedAt: null,
      availableMicro: 31_500_000, frozenMicro: 0, depositedMicro: 220 * USDT_MICRO,
      senderWallets: [{ address: SENDER_IVAN, deposits: 1, lastAt: t0 - 4 * DAY }],
    },
    {
      id: 3, telegramId: 7_114_902_518, username: 'masha_k', firstName: 'Маша', lastName: null, languageCode: 'ru',
      createdAt: t0 - 11 * DAY, lastSeenAt: t0 - 3 * MIN, blocked: false, missedConfirmations: 0, supportLockedAt: null, botBlockedAt: null,
      availableMicro: 74 * USDT_MICRO, frozenMicro: 0, depositedMicro: 120 * USDT_MICRO, senderWallets: [],
    },
    ...([
      [4, 'alex_trade', 'Алексей', 900, 0, null],
      [5, 'kate_m', 'Катя', 420, 1, null],
      [6, null, 'Дмитрий', 380, 0, null],
      [7, 'serg_p2p', 'Сергей', 1200, 0, null],
      [8, 'olga_v', 'Ольга', 260, 3, 'bot'],
      [9, 'max_crypto', 'Макс', 640, 0, null],
    ] as const).map(([id, username, firstName, usdt, missed, flag]): MockUser => ({
      id, telegramId: 6_100_000_000 + id * 7919, username, firstName, lastName: null, languageCode: 'ru',
      createdAt: t0 - (id * 3) * DAY, lastSeenAt: t0 - id * MIN, blocked: false, missedConfirmations: missed,
      supportLockedAt: null, botBlockedAt: flag === 'bot' ? t0 - DAY : null,
      availableMicro: usdt * USDT_MICRO, frozenMicro: 0, depositedMicro: usdt * USDT_MICRO, senderWallets: [],
    })),
  ];
  interface MockCheck { id: number; code: string; creatorId: number; amountMicro: number; comment: string | null; status: CheckDto['status']; createdAt: number; claimedBy: number | null; claimedAt: number | null }
  interface MockTransfer { id: number; from: number; to: number; amountMicro: number; kind: 'direct' | 'check'; comment: string | null; requestId: string | null; createdAt: number }
  const checks: MockCheck[] = [];
  const transfers: MockTransfer[] = [];
  const BOT = 'cryptoix_bot';
  interface MockOrder {
    id: number; userId: number; requestId: string; kind: ServiceKind; status: OrderStatus; amountRub: number; amountMicro: number;
    rate: number; exchangeRate: number; discountPercent: number; uin: string | null; fine: FineInfo | null;
    amountSource: 'provider' | 'user' | null; phone: string | null; steamLogin: string | null; clarifyMessage: string | null;
    rejectReason: string | null; balanceBeforeMicro: number; createdAt: number; finishedAt: number | null; events: WithdrawalEventDto[];
  }
  const orders: MockOrder[] = [];
  const DISCOUNT = 10;
  // Demo stand-in for the Rapira price behind the wallet rate.
  const exchange = () => Math.round((snapshot.rate.walletRate / 1.05) * 100) / 100;
  const sRate = () => serviceRate(exchange(), DISCOUNT);
  /** Demo fines database: any valid UIN is a speeding fine, UINs ending in 0000 are "already paid". */
  const demoFine = (uin: string): FineInfo | null => {
    if (uin.endsWith('0000')) return null;
    const issued = Date.now() - 6 * 24 * 60 * 60 * 1000;
    return {
      uin, amountRub: 1000, discountedAmountRub: 500, discountUntil: issued + 20 * 24 * 60 * 60 * 1000, issuedAt: issued,
      article: 'ч. 2 ст. 12.9 КоАП РФ', description: 'Превышение установленной скорости на 20-40 км/ч',
    };
  };
  const notifications: (NotificationDto & { userId: number; seen: boolean })[] = [];
  let transferId = 1;
  let checkId = 1;

  // Deposits: a pool of 10 addresses lent per request, seeded history, and one simulated
  // incoming transfer a few seconds after the demo user asks for an address.
  // Deliberately invalid addresses (contain 0 and O, which TRON never has): no wallet will accept them.
  const pool: { id: number; address: string; label: string; enabled: boolean; own: boolean; createdAt: number }[] = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, address: `T0DEM0ADDRESS0NOT0REAL0O000000000${i}`, label: `Аккаунт ${i + 1}`, enabled: true, own: false, createdAt: t0 - 30 * DAY,
  }));
  pool.push({ id: 11, address: 'T0DEM0MAIN0WALLET0NOT0REAL0O00000', label: 'Основной', enabled: true, own: true, createdAt: t0 - 30 * DAY });
  let poolId = 12;
  interface MockRequest { id: number; userId: number; address: string; status: DepositRequestStatus; createdAt: number; expiresAt: number; endedAt: number | null }
  const requests: MockRequest[] = [];
  let requestId = 1;
  type MockDeposit = Omit<AdminDepositDto, 'user' | 'issuedTo' | 'senderUsers'> & { userId: number | null; issuedToId: number | null };
  const deposits: MockDeposit[] = [];
  let depositId = 1;
  const addDeposit = (userId: number | null, amountUsdt: number, status: MockDeposit['status'], at: number, extra: Partial<MockDeposit> = {}): MockDeposit => {
    const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const d: MockDeposit = {
      id: depositId++, userId, issuedToId: userId, status, amountMicro: Math.round(amountUsdt * USDT_MICRO),
      address: pool[(depositId * 3) % 10].address, txId: hex(64),
      fromAddress: userId === 2 ? SENDER_IVAN : SENDER_ANN, amlDecision: status === 'pending' ? null : 'clear',
      amlSignals: status === 'pending' ? [] : [{ source: 'tether_blacklist', hit: false }, { source: 'ofac_sdn', hit: false }],
      blockNumber: 86_800_000 + depositId * 1000, createdAt: at, confirmedAt: status === 'pending' ? null : at + MIN,
      finishedAt: status === 'credited' || status === 'rejected' || status === 'below_min' ? at + MIN : null,
      creditedBy: status === 'credited' ? 'auto' : null, adminNote: null, review: null, late: false, requestId: null, ...extra,
    };
    deposits.push(d);
    return d;
  };
  addDeposit(1, 300, 'credited', t0 - 19 * DAY);
  addDeposit(1, 100, 'credited', t0 - 6 * DAY, { late: true });
  addDeposit(2, 220, 'credited', t0 - 4 * DAY + HOUR);
  addDeposit(2, 150, 'held', t0 - 35 * MIN, {
    fromAddress: 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G', amlDecision: 'reject', review: 'aml',
    amlSignals: [{ source: 'tether_blacklist', hit: true, detail: 'Адрес заморожен Tether' }, { source: 'ofac_sdn', hit: false }],
  });
  addDeposit(null, 75, 'held', t0 - 3 * HOUR, { review: 'linked_sender', issuedToId: null });
  addDeposit(null, 40, 'held', t0 - 5 * HOUR, { review: 'unidentified', issuedToId: null, fromAddress: 'TXa1bQ9cR8dS7eT6fU5gV4hW3iX2jY1kZm' });
  const depositDto = (d: MockDeposit): DepositDto => ({
    id: d.id, status: d.status === 'failed' ? 'rejected' : d.status, amountMicro: d.amountMicro, network: 'TRC20', txId: d.txId,
    fromAddress: d.fromAddress, createdAt: d.createdAt, creditedAt: d.status === 'credited' ? d.finishedAt : null,
  });
  const userRef = (id: number | null) => {
    const u = id ? users.find((x) => x.id === id) : null;
    return u ? { id: u.id, username: u.username, firstName: u.firstName, telegramId: u.telegramId } : null;
  };
  const depositAdmin = (d: MockDeposit): AdminDepositDto => {
    const { userId, issuedToId, ...rest } = d;
    const senders = [...new Set(deposits.filter((x) => x.id !== d.id && x.status === 'credited' && x.fromAddress === d.fromAddress && x.userId).map((x) => x.userId!))];
    return { ...rest, user: userRef(userId), issuedTo: userRef(issuedToId), senderUsers: senders.map((id) => userRef(id)!) };
  };
  const creditDeposit = (d: MockDeposit, by: 'auto' | 'admin', note: string | null, toUser?: number) => {
    if (!['pending', 'held', 'below_min'].includes(d.status)) fail(409, 'Пополнение уже обработано');
    const uid = toUser ?? d.userId ?? fail(400, 'Выберите, кому зачислить');
    const u = users.find((x) => x.id === uid) ?? fail(404, 'Пользователь не найден');
    d.userId = u.id;
    d.status = 'credited';
    d.finishedAt = now();
    d.creditedBy = by;
    if (note) d.adminNote = note;
    engine.credit(u.id, d.amountMicro);
    u.depositedMicro += d.amountMicro;
    notify(u.id, 'deposit_credited', null, { deposit: depositDto(d) });
  };
  const expireRequests = () => {
    for (const r of requests) if (r.status === 'active' && r.expiresAt <= now()) Object.assign(r, { status: 'expired', endedAt: r.expiresAt });
  };
  const lastOn = (address: string) => {
    const r = requests.filter((x) => x.address === address).at(-1);
    return r ? { r, freeAt: (r.status === 'active' ? r.expiresAt : (r.endedAt ?? r.expiresAt)) + DEPOSIT_QUARANTINE_MS } : null;
  };
  const requestDto = (r: MockRequest): DepositRequestDto => ({
    ...r, serverNow: now(), receivedMicro: deposits.filter((d) => d.requestId === r.id).reduce((s, d) => s + d.amountMicro, 0),
    creditedMicro: deposits.filter((d) => d.requestId === r.id && d.status === 'credited').reduce((s, d) => s + d.amountMicro, 0),
  });
  const depositInfo = (userId: number): DepositInfoDto => {
    expireRequests();
    const r = requests.filter((x) => x.userId === userId).at(-1);
    const show = r && r.status !== 'cancelled' && (r.status === 'active' || (r.endedAt ?? 0) > now() - 10 * MIN);
    return {
      token: 'USDT', network: 'TRC20', networkName: 'TRON (TRC-20)', enabled: pool.some((p) => p.enabled && !p.own),
      request: show ? requestDto(r) : null, minDepositMicro: 0, confirmations: 20, demo: true,
    };
  };
  let demoDepositSent = false;
  const simulateDeposit = (r: MockRequest) => {
    if (demoDepositSent) return;
    demoDepositSent = true;
    setTimeout(() => {
      if (r.status !== 'active') return void (demoDepositSent = false);
      const d = addDeposit(r.userId, 50, 'pending', now(), { address: r.address, requestId: r.id });
      Object.assign(r, { status: 'paid', endedAt: now() });
      setTimeout(() => {
        d.confirmedAt = now();
        d.amlDecision = 'clear';
        d.amlSignals = [{ source: 'tether_blacklist', hit: false }, { source: 'ofac_sdn', hit: false }];
        creditDeposit(d, 'auto', null);
      }, 9000);
    }, 8000);
  };
  const poolList = (): AdminDepositAddressDto[] => {
    expireRequests();
    return pool.map((p) => {
      const last = lastOn(p.address);
      const lent = last && last.freeAt > now() ? last : null;
      const credited = deposits.filter((d) => d.address === p.address && d.status === 'credited');
      return {
        ...p, lastCheckedAt: now() - 15_000, holder: lent ? userRef(lent.r.userId) : null,
        state: p.own ? 'own' : lent?.r.status === 'active' ? 'busy' : lent ? 'quarantine' : p.enabled ? 'free' : 'off',
        until: lent ? (lent.r.status === 'active' ? lent.r.expiresAt : lent.freeAt) : null,
        depositsCount: credited.length, receivedMicro: credited.reduce((s, d) => s + d.amountMicro, 0),
      };
    });
  };

  // USDT TRC-20 withdrawals: the demo operator "sends" them from the admin panel.
  const USDT_FEE = 5 * USDT_MICRO;
  const USDT_MIN = 10 * USDT_MICRO;
  interface MockPayout { id: number; userId: number; requestId: string; address: string; amountMicro: number; status: UsdtPayoutStatus; txId: string | null; rejectReason: string | null; adminNote: string | null; balanceBefore: number; createdAt: number; finishedAt: number | null }
  const payouts: MockPayout[] = [];
  let payoutId = 1;
  const payoutDto = (p: MockPayout): UsdtPayoutDto => ({
    id: p.id, address: p.address, amountMicro: p.amountMicro, feeMicro: USDT_FEE, totalMicro: p.amountMicro + USDT_FEE, status: p.status,
    txId: p.txId, rejectReason: p.rejectReason, createdAt: p.createdAt, finishedAt: p.finishedAt,
  });
  const payoutAdmin = (p: MockPayout): AdminUsdtPayoutDto => ({
    ...payoutDto(p), user: userRef(p.userId)!, amlDecision: 'clear', amlSignals: [{ source: 'tether_blacklist', hit: false }, { source: 'ofac_sdn', hit: false }],
    adminNote: p.adminNote, balanceBeforeMicro: p.balanceBefore,
    sameAddressBefore: payouts.filter((x) => x.id !== p.id && x.userId === p.userId && x.address === p.address && x.status === 'sent').length,
  });
  payouts.push(
    { id: payoutId++, userId: 1, requestId: 'seed1', address: 'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', amountMicro: 120 * USDT_MICRO, status: 'sent', txId: 'b'.repeat(64), rejectReason: null, adminNote: null, balanceBefore: 500 * USDT_MICRO, createdAt: t0 - 9 * DAY, finishedAt: t0 - 9 * DAY + 25 * MIN },
    { id: payoutId++, userId: 7, requestId: 'seed2', address: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', amountMicro: 300 * USDT_MICRO, status: 'new', txId: null, rejectReason: null, adminNote: null, balanceBefore: 1500 * USDT_MICRO, createdAt: t0 - 7 * MIN, finishedAt: null },
  );
  const payoutUser = (p: MockPayout) => users.find((u) => u.id === p.userId)!;
  users.find((u) => u.id === 7)!.availableMicro -= 305 * USDT_MICRO;
  users.find((u) => u.id === 7)!.frozenMicro += 305 * USDT_MICRO;

  const user = (id: number) => users.find((u) => u.id === id) ?? fail(404, 'Пользователь не найден');

  const notify = (userId: number, type: NotificationType, withdrawalId: number | null, extra: Partial<NotificationDto> = {}) =>
    notifications.push({ id: notificationId++, userId, type, withdrawalId, createdAt: now(), seen: false, ...extra });

  const person = (id: number): PersonDto => {
    const u = user(id);
    return { username: u.username, firstName: u.firstName, photoUrl: null };
  };
  const transferDto = (t: MockTransfer, viewer: number): TransferDto => {
    const direction = t.to === viewer ? 'in' : 'out';
    return { id: t.id, direction, kind: t.kind, amountMicro: t.amountMicro, counterparty: person(direction === 'in' ? t.from : t.to), comment: t.comment, createdAt: t.createdAt };
  };
  const checkDto = (c: MockCheck): CheckDto => ({
    id: c.id, code: c.code, amountMicro: c.amountMicro, comment: c.comment, status: c.status, createdAt: c.createdAt,
    claimedAt: c.claimedAt, claimedBy: c.claimedBy ? person(c.claimedBy) : null, link: checkLink(BOT, c.code),
  });
  const amountOf = (input: string) => {
    const a = parseUsdt(input);
    return typeof a === 'string' ? fail(400, a) : a;
  };
  const findByUsername = (input: string, selfId: number) => {
    const name = normalizeUsername(input);
    if (!isValidUsername(name)) fail(400, 'Введите username, например @durov');
    const u = users.find((x) => x.username?.toLowerCase() === name.toLowerCase());
    if (!u) fail(404, 'Пользователь не найден. Он должен хотя бы раз открыть кошелёк, или отправьте ему чек');
    if (u!.id === selfId) fail(400, 'Нельзя перевести самому себе');
    return u!;
  };

  const engine = createDealEngine({
    users,
    notify,
    walletRate: () => snapshot.rate.walletRate,
    transfersIn: (id) => transfers.filter((t) => t.to === id).reduce((a, t) => a + t.amountMicro, 0),
    transfersOut: (id) => transfers.filter((t) => t.from === id).reduce((a, t) => a + t.amountMicro, 0),
    activeChecks: (id) => checks.filter((c) => c.creatorId === id && c.status === 'active').reduce((a, c) => a + c.amountMicro, 0),
  });
  const adminUser = engine.adminUser;
  const { contactLock, assertNotLocked, answerLock } = engine;
  seedDeals(engine, users, t0, snapshot.rate.walletRate);

  const me = users[0];

  const orderTarget = (o: MockOrder) =>
    o.kind === 'fine' ? `УИН ${o.uin}` : o.kind === 'parking' ? formatParkingPhone(o.phone ?? '') : `Логин ${o.steamLogin}`;
  const orderBenefit = (o: MockOrder) => Math.max(0, Math.round(o.amountRub - (o.amountMicro / USDT_MICRO) * o.exchangeRate));
  const orderDto = (o: MockOrder): ServiceOrderDto => ({
    id: o.id, kind: o.kind, status: o.status, amountRub: o.amountRub, amountMicro: o.amountMicro, rate: o.rate,
    discountPercent: o.discountPercent, benefitRub: orderBenefit(o), target: orderTarget(o), fine: o.fine,
    clarifyMessage: o.status === 'clarify' ? o.clarifyMessage : null, rejectReason: o.rejectReason, createdAt: o.createdAt, finishedAt: o.finishedAt,
  });
  const orderItem = (o: MockOrder): AdminOrderListItem => {
    const u = user(o.userId);
    return { id: o.id, kind: o.kind, status: o.status, amountRub: o.amountRub, amountMicro: o.amountMicro, target: orderTarget(o),
      createdAt: o.createdAt, user: { id: u.id, username: u.username, firstName: u.firstName, telegramId: u.telegramId } };
  };
  const orderAdmin = (id: number): AdminOrderDto => {
    const o = orders.find((x) => x.id === id) ?? fail(404, 'Заявка не найдена');
    return { ...orderItem(o), rate: o.rate, exchangeRate: o.exchangeRate, discountPercent: o.discountPercent, benefitRub: orderBenefit(o),
      fine: o.fine, amountSource: o.amountSource, phone: o.phone, steamLogin: o.steamLogin, clarifyMessage: o.clarifyMessage,
      rejectReason: o.rejectReason, finishedAt: o.finishedAt, balanceBeforeMicro: o.balanceBeforeMicro, clientIp: '185.12.64.7 (демо)',
      platform: 'demo', events: o.events, userDetails: adminUser(o.userId), serverNow: now() };
  };
  const orderMove = (id: number, action: OrderAction) => {
    const o = orders.find((x) => x.id === id) ?? fail(404, 'Заявка не найдена');
    const to = nextOrderStatus(o.status, action);
    if (!to) fail(409, 'Действие недоступно в текущем статусе');
    o.status = to!;
    return o;
  };
  const addOrder = (u: MockUser, p: Omit<MockOrder, 'id' | 'userId' | 'status' | 'rate' | 'exchangeRate' | 'discountPercent' | 'balanceBeforeMicro' | 'finishedAt' | 'events' | 'clarifyMessage' | 'rejectReason'>) => {
    if (p.amountMicro > u.availableMicro) fail(400, 'Недостаточно средств');
    const o: MockOrder = { ...p, id: 501 + orders.length, userId: u.id, status: 'pending', rate: sRate(), exchangeRate: exchange(),
      discountPercent: DISCOUNT, balanceBeforeMicro: u.availableMicro, finishedAt: null, events: [], clarifyMessage: null, rejectReason: null };
    u.availableMicro -= o.amountMicro;
    u.frozenMicro += o.amountMicro;
    orders.push(o);
    o.events.push({ id: eventId++, at: o.createdAt, actor: 'user', type: 'created', data: { amountRub: o.amountRub, amountMicro: o.amountMicro, rate: o.rate } });
    return o;
  };
  // Seed: a pending Steam top-up from another user, so the МК queue is not empty.
  addOrder(users[3], { requestId: 'seed-steam', kind: 'steam', amountRub: 1500, amountMicro: serviceMicroForRub(1500, sRate()),
    uin: null, fine: null, amountSource: null, phone: null, steamLogin: 'ivan_k_pro', createdAt: t0 - 3 * MIN });

  const api: Api = {
    rate: () => delay(snapshot.rate),
    market: () => delay({ coins: snapshot.coins }),
    me: (): Promise<MeDto> =>
      delay({
        user: { id: me.id, telegramId: me.telegramId, username: me.username, firstName: me.firstName, lastName: me.lastName, photoUrl: null },
        availableMicro: me.availableMicro, frozenMicro: me.frozenMicro, blocked: me.blocked, supportUsername: 'cryptoix_support',
        contactLock: contactLock(me.id),
        answerLock: answerLock(me.id),
        usdtPayout: { feeMicro: USDT_FEE, minMicro: USDT_MIN },
        botUsername: BOT,
        stats: {
          exchanges: engine.deals.filter((w) => w.userId === me.id && w.status === 'completed').length,
          exchangedRub: engine.deals.filter((w) => w.userId === me.id && w.status === 'completed').reduce((a, w) => a + (w.finalRub ?? w.amountRub), 0),
          memberSince: me.createdAt,
        },
      }),
    withdrawals: () => delay({ items: engine.deals.filter((w) => w.userId === me.id).slice().reverse().map(engine.userDto) }),
    withdrawal: (id) => {
      const w = engine.deal(id);
      if (w.userId !== me.id) fail(404, 'Заявка не найдена');
      return delay(engine.userDto(w));
    },
    createWithdrawal: (req) => delay(engine.userDto(engine.create(me, req))),
    createUsdtPayout: (req) => {
      const dup = payouts.find((p) => p.userId === me.id && p.requestId === req.requestId);
      if (dup) return delay(payoutDto(dup));
      if (me.blocked) fail(403, 'Вывод недоступен. Свяжитесь с поддержкой');
      assertNotLocked(me.id);
      const address = req.address.trim();
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) fail(400, 'Это не адрес TRON. Он начинается на T и состоит из 34 символов');
      if (pool.some((x) => x.address === address)) fail(400, 'Это адрес пополнения Crypto IX. Укажите адрес своего кошелька или биржи');
      const amount = parseUsdt(req.amount);
      if (typeof amount === 'string') fail(400, amount);
      const err = validateUsdtPayout(amount as number, me.availableMicro, USDT_FEE, USDT_MIN);
      if (err) fail(400, err);
      const p: MockPayout = { id: payoutId++, userId: me.id, requestId: req.requestId, address, amountMicro: amount as number, status: 'new', txId: null, rejectReason: null, adminNote: null, balanceBefore: me.availableMicro, createdAt: now(), finishedAt: null };
      payouts.push(p);
      me.availableMicro -= p.amountMicro + USDT_FEE;
      me.frozenMicro += p.amountMicro + USDT_FEE;
      return delay(payoutDto(p));
    },
    usdtPayout: (id) => {
      const p = payouts.find((x) => x.id === id && x.userId === me.id) ?? fail(404, 'Заявка не найдена');
      return delay(payoutDto(p));
    },
    dealReceived: (id) => delay(engine.userDto(engine.userReceived(me.id, id))),
    dealNotReceived: (id) => delay(engine.userDto(engine.userNotReceived(me.id, id))),
    dealNotYet: (id) => delay(engine.userDto(engine.userNotYet(me.id, id))),
    dealOtherAmount: (id, rub) => delay(engine.userDto(engine.userOtherAmount(me.id, id, rub))),
    notifications: () =>
      delay({
        items: notifications
          .filter((n) => n.userId === me.id && !n.seen)
          .map(({ id, type, withdrawalId, createdAt, transfer, check, order, deposit, deduction, usdtPayout }) => ({ id, type, withdrawalId, createdAt, transfer, check, order, deposit, deduction, usdtPayout })),
      }),
    markNotificationsSeen: (ids) => {
      for (const n of notifications) if (ids.includes(n.id)) n.seen = true;
      return delay({ ok: true });
    },
    history: () => {
      const items: HistoryItem[] = [
        ...engine.deals.filter((w) => w.userId === me.id).map((w): HistoryItem => ({ type: 'withdrawal', at: w.createdAt, withdrawal: engine.userDto(w) })),
        ...engine.deductionsFor(me.id).map((d): HistoryItem => ({ type: 'deduction', at: d.createdAt, deduction: d })),
        ...transfers
          .filter((t) => t.to === me.id || (t.from === me.id && t.kind === 'direct'))
          .map((t): HistoryItem => ({ type: 'transfer', at: t.createdAt, transfer: transferDto(t, me.id) })),
        ...checks.filter((c) => c.creatorId === me.id).map((c): HistoryItem => ({ type: 'check', at: c.createdAt, check: checkDto(c) })),
        ...orders.filter((o) => o.userId === me.id).map((o): HistoryItem => ({ type: 'order', at: o.createdAt, order: orderDto(o) })),
        ...payouts.filter((p) => p.userId === me.id).map((p): HistoryItem => ({ type: 'usdt_payout', at: p.createdAt, usdtPayout: payoutDto(p) })),
        ...deposits.filter((d) => d.userId === me.id && d.status !== 'failed').map((d): HistoryItem => ({ type: 'deposit', at: d.createdAt, deposit: depositDto(d) })),
      ];
      return delay({ items: items.sort((a, b) => b.at - a.at) });
    },
    deposit: () => delay(depositInfo(me.id)),
    depositOpen: () => {
      assertNotLocked(me.id);
      expireRequests();
      if (requests.some((r) => r.userId === me.id && r.status === 'active')) fail(409, 'Сначала отмените текущую заявку');
      const mine = pool.find((p) => { const l = lastOn(p.address); return p.enabled && !p.own && l && l.r.userId === me.id && l.r.status !== 'active' && l.freeAt > now(); });
      const free = pool.filter((p) => p.enabled && !p.own && (lastOn(p.address)?.freeAt ?? 0) <= now())
        .sort((a, b) => (lastOn(a.address)?.freeAt ?? 0) - (lastOn(b.address)?.freeAt ?? 0))[0];
      const p = mine ?? free ?? fail(409, 'Все адреса сейчас заняты. Попробуйте чуть позже');
      const r: MockRequest = { id: requestId++, userId: me.id, address: p.address, status: 'active', createdAt: now(), expiresAt: now() + DEPOSIT_REQUEST_TTL_MS, endedAt: null };
      requests.push(r);
      simulateDeposit(r);
      return delay(depositInfo(me.id));
    },
    depositCancel: () => {
      const r = requests.find((x) => x.userId === me.id && x.status === 'active') ?? fail(409, 'Активной заявки нет');
      Object.assign(r, { status: 'cancelled', endedAt: now() });
      return delay(depositInfo(me.id));
    },
    servicesConfig: () =>
      delay({ discountPercent: DISCOUNT, serviceRate: sRate(), fineLookupAvailable: true,
        steam: { minRub: STEAM_MIN_RUB, maxRub: STEAM_MAX_RUB }, parking: { minRub: MIN_PARKING_RUB, maxRub: MAX_PARKING_RUB } }),
    lookupFine: (uin) => {
      const e = validateUin(uin);
      if (e) fail(400, e);
      const fine = demoFine(normalizeUin(uin));
      return delay(fine ? { found: true as const, fine } : { found: false as const, manual: false, message: 'Штраф с таким УИН не найден или уже оплачен' });
    },
    createOrder: (req) => {
      const dup = orders.find((o) => o.userId === me.id && o.requestId === req.requestId);
      if (dup) return delay(orderDto(dup));
      if (me.blocked) fail(403, 'Операции недоступны. Свяжитесь с поддержкой');
      assertNotLocked(me.id);
      const rate = sRate();
      const base = { requestId: req.requestId, kind: req.kind, uin: null, fine: null, amountSource: null, phone: null, steamLogin: null, createdAt: now() };
      let o: MockOrder;
      if (req.kind === 'fine') {
        const e = validateUin(req.uin ?? '');
        if (e) fail(400, e);
        const fine = demoFine(normalizeUin(req.uin!)) ?? fail(404, 'Штраф с таким УИН не найден или уже оплачен');
        const rub = fineDueRub(fine);
        o = addOrder(me, { ...base, uin: fine.uin, fine, amountSource: 'provider', amountRub: rub, amountMicro: serviceMicroForRub(rub, rate) });
      } else if (req.kind === 'parking') {
        const e = validateParkingPhone(req.phone ?? '') ?? validateParkingAmount(Number(req.amountRub));
        if (e) fail(400, e);
        o = addOrder(me, { ...base, phone: normalizeParkingPhone(req.phone!), amountRub: Number(req.amountRub), amountMicro: serviceMicroForRub(Number(req.amountRub), rate) });
      } else {
        const e = validateSteamLogin(req.steamLogin ?? '');
        if (e) fail(400, e);
        const micro = amountOf(req.amountUsdt ?? '');
        const rub = rubForServiceMicro(micro, rate);
        const re = validateSteamRub(rub);
        if (re) fail(400, re);
        o = addOrder(me, { ...base, steamLogin: req.steamLogin!.trim(), amountRub: rub, amountMicro: micro });
      }
      return delay(orderDto(o));
    },
    order: (id) => {
      const o = orders.find((x) => x.id === id && x.userId === me.id) ?? fail(404, 'Заявка не найдена');
      return delay(orderDto(o));
    },
    lookupUser: (username) => delay(person(findByUsername(username, me.id).id)),
    sendTransfer: (req) => {
      const dup = transfers.find((t) => t.from === me.id && t.requestId === req.requestId);
      if (dup) return delay(transferDto(dup, me.id));
      assertNotLocked(me.id);
      const to = findByUsername(req.username, me.id);
      const amountMicro = amountOf(req.amount);
      if (amountMicro > me.availableMicro) fail(400, 'Недостаточно средств');
      me.availableMicro -= amountMicro;
      engine.credit(to.id, amountMicro);
      const t: MockTransfer = { id: transferId++, from: me.id, to: to.id, amountMicro, kind: 'direct', comment: cleanComment(req.comment), requestId: req.requestId, createdAt: now() };
      transfers.push(t);
      return delay(transferDto(t, me.id));
    },
    checks: () => delay({ items: checks.filter((c) => c.creatorId === me.id).reverse().map(checkDto) }),
    createCheck: (req) => {
      assertNotLocked(me.id);
      const amountMicro = amountOf(req.amount);
      if (amountMicro > me.availableMicro) fail(400, 'Недостаточно средств');
      me.availableMicro -= amountMicro;
      me.frozenMicro += amountMicro;
      const code = Math.random().toString(36).slice(2, 12);
      const c: MockCheck = { id: checkId++, code, creatorId: me.id, amountMicro, comment: cleanComment(req.comment), status: 'active', createdAt: now(), claimedBy: null, claimedAt: null };
      checks.push(c);
      return delay(checkDto(c));
    },
    cancelCheck: (id) => {
      const c = checks.find((x) => x.id === id && x.creatorId === me.id) ?? fail(404, 'Чек не найден');
      if (c.status !== 'active') fail(409, 'Чек уже активирован или отменён');
      c.status = 'cancelled';
      me.frozenMicro -= c.amountMicro;
      engine.credit(me.id, c.amountMicro);
      return delay(checkDto(c));
    },
    demoClaimCheck: (code) => {
      const c = checks.find((x) => x.code === code) ?? fail(404, 'Чек не найден');
      if (c.status !== 'active') fail(409, 'Этот чек уже активирован');
      const friend = users[2];
      c.status = 'claimed';
      c.claimedBy = friend.id;
      c.claimedAt = now();
      user(c.creatorId).frozenMicro -= c.amountMicro;
      engine.credit(friend.id, c.amountMicro);
      transfers.push({ id: transferId++, from: c.creatorId, to: friend.id, amountMicro: c.amountMicro, kind: 'check', comment: c.comment, requestId: null, createdAt: now() });
      notify(c.creatorId, 'check_claimed', null, { check: checkDto(c) });
      return delay({ ok: true });
    },
  };

  // Demo: a friend sends the user a little USDT a few seconds after opening, to show the incoming notice.
  setTimeout(() => {
    const t: MockTransfer = { id: transferId++, from: users[2].id, to: me.id, amountMicro: 15 * USDT_MICRO, kind: 'direct', comment: 'Возвращаю за обед', requestId: null, createdAt: now() };
    users[2].availableMicro -= t.amountMicro;
    engine.credit(me.id, t.amountMicro);
    transfers.push(t);
    notify(me.id, 'transfer_received', null, { transfer: transferDto(t, me.id) });
  }, 4000);

  // Statistics: real demo deals on top of a made-up history, so the chart has something to show.
  const statsDto = (): AdminStatsDto => {
    const H = 3_600_000;
    const dayOf = (t: number) => Math.floor((t + 3 * H) / DAY) * DAY - 3 * H;
    const today = dayOf(now());
    const paid = engine.deals.filter((d) => d.status === 'completed' || d.status === 'user_confirmed');
    const paidAt = (d: (typeof paid)[number]) => d.finishedAt ?? d.userConfirmedAt ?? d.userDecidedAt ?? d.createdAt;
    const history = (i: number) => (i === 0 ? { rub: 0, n: 0 } : { rub: Math.round((260 + 55 * (14 - i) + ((i * 7919) % 13) * 31) * 1000), n: 14 + ((i * 31) % 9) + (14 - i) * 2 });
    const days = Array.from({ length: 14 }, (_, k) => {
      const i = 13 - k;
      const from = today - i * DAY;
      const real = paid.filter((d) => paidAt(d) >= from && paidAt(d) < from + DAY);
      const fake = history(i);
      return { day: from, payoutRub: fake.rub + real.reduce((a, d) => a + (d.finalRub ?? d.amountRub), 0), payoutCount: fake.n + real.length };
    });
    const period = (label: string, from: number, to: number): AdminStatsPeriod => {
      const ds = days.filter((d) => d.day >= from && d.day < to);
      const rub = ds.reduce((a, d) => a + d.payoutRub, 0);
      const n = ds.reduce((a, d) => a + d.payoutCount, 0);
      const created = engine.deals.filter((d) => d.createdAt >= from && d.createdAt < to);
      const span = Math.max(1, Math.round((Math.min(to, now()) - from) / DAY));
      const sent = payouts.filter((x) => x.status === 'sent' && (x.finishedAt ?? 0) >= from && (x.finishedAt ?? 0) < to);
      const dep = deposits.filter((d) => d.status === 'credited' && (d.finishedAt ?? 0) >= from && (d.finishedAt ?? 0) < to);
      return {
        label, from, to, payoutRub: rub, payoutMicro: Math.round((rub / snapshot.rate.walletRate) * USDT_MICRO), payoutCount: n,
        payoutUsers: Math.max(n ? 1 : 0, Math.round(n / 2.6)), avgDealMinutes: n ? 17.4 : null, avgResponseMinutes: n ? 3.1 : null,
        dealsCreated: n + created.length, dealsCancelled: Math.round(n / 20),
        usdtPayoutCount: sent.length + span * 2, usdtPayoutMicro: sent.reduce((a, x) => a + x.amountMicro, 0) + span * 340 * USDT_MICRO,
        usdtFeesMicro: (sent.length + span * 2) * USDT_FEE,
        depositCount: dep.length + span * 9, depositMicro: dep.reduce((a, d) => a + d.amountMicro, 0) + span * 3900 * USDT_MICRO,
        ordersCount: orders.filter((o) => o.status === 'paid').length + span, ordersRub: span * 4200,
        transferCount: transfers.length + span * 6, transferMicro: transfers.reduce((a, t) => a + t.amountMicro, 0) + span * 410 * USDT_MICRO,
        newUsers: span * 11,
      };
    };
    const active = engine.deals.filter((d) => d.status !== 'completed' && d.status !== 'cancelled');
    const byStatus: Record<string, number> = {};
    for (const d of active) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    return {
      serverNow: now(),
      periods: [period('Сегодня', today, now() + 1), period('Вчера', today - DAY, today), period('7 дней', today - 6 * DAY, now() + 1), period('30 дней', today - 29 * DAY, now() + 1)],
      days,
      now: {
        activeDeals: active.length, dealsByStatus: byStatus, usdtPayoutsWaiting: payouts.filter((x) => x.status === 'new').length,
        depositsHeld: deposits.filter((d) => d.status === 'held').length, usersTotal: 1240 + users.length,
        availableMicro: users.reduce((a, u) => a + u.availableMicro, 0) + 48_200 * USDT_MICRO, frozenMicro: users.reduce((a, u) => a + u.frozenMicro, 0),
      },
      topUsers: [7, 4, 9, 5, 2].map((id, i) => {
        const u = users.find((x) => x.id === id)!;
        return { id, username: u.username, firstName: u.firstName, deals: 31 - i * 5, rub: (1_240 - i * 210) * 1000 };
      }),
    };
  };

  const admin: AdminApi = {
    stats: () => delay(statsDto()),
    board: () => delay(engine.admin.board()),
    archive: (q) => delay(engine.admin.archive(q)),
    deal: (id) => delay(engine.admin.deal(id)),
    dealAction: (id, action, body = {}) => delay(engine.admin.dealAction(id, action, body)),
    users: (q) => delay(engine.admin.users(q)),
    user: (id) => delay(engine.admin.user(id)),
    adjustBalance: (userId, amountUsdt, comment) => delay(engine.admin.adjust(userId, amountUsdt, comment)),
    setBlocked: (userId, blocked) => delay(engine.admin.setBlocked(userId, blocked)),
    setSupportLock: (userId, locked) => delay(engine.admin.setSupportLock(userId, locked)),
    obligations: (f) => delay(engine.admin.obligationsList(f)),
    createObligation: (req) => delay(engine.admin.createObligation(req)),
    writeOffObligation: (id, comment) => delay(engine.admin.writeOff(id, comment)),
    journal: (q) => delay(engine.admin.journal(q)),
    broadcasts: () => delay(engine.admin.broadcasts()),
    broadcastTest: (req) => delay(engine.admin.broadcastTest(req)),
    broadcastSend: (req) => delay(engine.admin.broadcastSend(req)),
    orders: (status) => {
      const c: AdminOrderCounts = { pending: 0, clarify: 0, paid: 0, rejected: 0 };
      for (const o of orders) c[o.status]++;
      return delay({ items: orders.filter((o) => status === 'all' || o.status === status).slice().reverse().map(orderItem), counts: c });
    },
    orderGet: (id) => delay(orderAdmin(id)),
    orderPaid: (id) => {
      const o = orderMove(id, 'paid');
      user(o.userId).frozenMicro -= o.amountMicro;
      o.finishedAt = now();
      o.events.push({ id: eventId++, at: now(), actor: 'admin', type: 'paid', data: {} });
      notify(o.userId, 'order_paid', null, { order: orderDto(o) });
      return delay(orderAdmin(id));
    },
    orderClarify: (id, message) => {
      if (!message.trim()) fail(400, 'Напишите, что нужно уточнить');
      const o = orderMove(id, 'clarify');
      o.clarifyMessage = message.trim();
      o.events.push({ id: eventId++, at: now(), actor: 'admin', type: 'clarify', data: { message: o.clarifyMessage } });
      notify(o.userId, 'order_clarify', null, { order: orderDto(o) });
      return delay(orderAdmin(id));
    },
    orderReject: (id, reason) => {
      if (!reason.trim()) fail(400, 'Укажите причину отклонения');
      const o = orderMove(id, 'reject');
      const u = user(o.userId);
      u.frozenMicro -= o.amountMicro;
      engine.credit(u.id, o.amountMicro);
      o.finishedAt = now();
      o.rejectReason = reason.trim();
      o.events.push({ id: eventId++, at: now(), actor: 'admin', type: 'rejected', data: { reason: o.rejectReason } });
      notify(o.userId, 'order_rejected', null, { order: orderDto(o) });
      return delay(orderAdmin(id));
    },
    orderNote: (id, text) => {
      if (!text.trim()) fail(400, 'Пустая заметка');
      const o = orders.find((x) => x.id === id) ?? fail(404, 'Заявка не найдена');
      o.events.push({ id: eventId++, at: now(), actor: 'admin', type: 'note', data: { text: text.trim() } });
      return delay(orderAdmin(id));
    },
    deposits: (status) => {
      const c: AdminDepositCounts = { held: 0, below_min: 0, pending: 0, credited: 0, rejected: 0 };
      for (const d of deposits) if (d.status !== 'failed') c[d.status]++;
      const items = deposits.filter((d) => status === 'all' || d.status === status).slice().reverse().map(depositAdmin);
      return delay({ items, counts: c, enabled: pool.some((p) => p.enabled && !p.own) });
    },
    depositPool: () => delay({ items: poolList() }),
    usdtPayouts: (status) => {
      const items = payouts.filter((p) => status === 'all' || p.status === status);
      if (status !== 'new') items.reverse();
      const c = { new: 0, sent: 0, rejected: 0 };
      for (const p of payouts) c[p.status]++;
      return delay({ items: items.map(payoutAdmin), counts: c });
    },
    usdtPayoutSent: (id, txIdRaw, force) => {
      const txId = txIdRaw.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txId)) fail(400, 'Хэш транзакции: 64 символа 0-9 и a-f. Скопируйте его из TronLink или Tronscan');
      const p = payouts.find((x) => x.id === id) ?? fail(404, 'Заявка не найдена');
      if (p.status !== 'new') fail(409, 'Заявка уже обработана');
      const used = payouts.find((x) => x.txId === txId);
      if (used) fail(409, `Этот хэш уже указан в заявке №${used.id}`);
      Object.assign(p, { status: 'sent', txId, finishedAt: now(), adminNote: force ? 'без проверки в сети' : null });
      payoutUser(p).frozenMicro -= p.amountMicro + USDT_FEE;
      notify(p.userId, 'usdt_payout_sent', null, { usdtPayout: payoutDto(p) });
      return delay(payoutAdmin(p));
    },
    usdtPayoutReject: (id, reason) => {
      if (!reason.trim()) fail(400, 'Укажите причину, её увидит клиент');
      const p = payouts.find((x) => x.id === id) ?? fail(404, 'Заявка не найдена');
      if (p.status !== 'new') fail(409, 'Заявка уже обработана');
      Object.assign(p, { status: 'rejected', rejectReason: reason.trim(), finishedAt: now() });
      const u = payoutUser(p);
      u.frozenMicro -= p.amountMicro + USDT_FEE;
      u.availableMicro += p.amountMicro + USDT_FEE;
      notify(p.userId, 'usdt_payout_rejected', null, { usdtPayout: payoutDto(p) });
      return delay(payoutAdmin(p));
    },
    depositPoolAdd: (address, label, own) => {
      const a = address.trim();
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) fail(400, 'Это не адрес TRON. Он начинается на T и состоит из 34 символов');
      if (pool.some((p) => p.address === a)) fail(409, 'Этот адрес уже добавлен');
      pool.push({ id: poolId++, address: a, label: label.trim(), enabled: true, own, createdAt: now() });
      return delay({ items: poolList() });
    },
    depositPoolUpdate: (id, patch) => {
      const p = pool.find((x) => x.id === id) ?? fail(404, 'Адрес не найден');
      if (patch.enabled !== undefined) p.enabled = patch.enabled;
      if (patch.label !== undefined) p.label = patch.label.trim();
      return delay({ items: poolList() });
    },
    depositPoolRemove: (id) => {
      const p = pool.find((x) => x.id === id) ?? fail(404, 'Адрес не найден');
      if (requests.some((r) => r.address === p.address) || deposits.some((d) => d.address === p.address)) fail(409, 'Адрес уже выдавался. Его можно только выключить');
      pool.splice(pool.indexOf(p), 1);
      return delay({ items: poolList() });
    },
    depositCredit: (id, note, userId) => {
      const d = deposits.find((x) => x.id === id) ?? fail(404, 'Пополнение не найдено');
      creditDeposit(d, 'admin', note.trim() || null, userId);
      return delay(depositAdmin(d));
    },
    depositReject: (id, reason) => {
      if (!reason.trim()) fail(400, 'Укажите причину');
      const d = deposits.find((x) => x.id === id) ?? fail(404, 'Пополнение не найдено');
      if (!['held', 'below_min'].includes(d.status)) fail(409, 'Пополнение уже обработано');
      d.status = 'rejected';
      d.finishedAt = now();
      d.adminNote = reason.trim();
      return delay(depositAdmin(d));
    },
  };

  return { api, admin, warp: engine.warp };
}

/** Demo board: deals of other users in every state, plus a small archive and shadow holds. */
function seedDeals(engine: ReturnType<typeof createDealEngine>, users: MockUser[], t0: number, rate: number) {
  const u = (id: number) => users.find((x) => x.id === id)!;
  u(2).availableMicro = 200 * USDT_MICRO;
  const sbp = (phone: string, bankId: string, bankName: string) => ({ method: 'sbp' as const, phone, bankId, bankName, cardNumber: null });
  const card = (cardNumber: string) => ({ method: 'card' as const, phone: null, bankId: null, bankName: null, cardNumber });
  const add = (userId: number, amountRub: number, createdAt: number, dest: ReturnType<typeof sbp> | ReturnType<typeof card>) =>
    engine.addDeal(u(userId), { requestId: `seed-${userId}-${createdAt}`, amountRub, amountMicro: Math.ceil((amountRub / rate) * 1e6), rate, createdAt, ...dest });
  type D = ReturnType<typeof add>;
  const take = (d: D, at: number) => {
    Object.assign(d, { status: 'in_work', takenAt: at });
    engine.log('admin', 'deal_taken', { userId: d.userId, withdrawalId: d.id, at });
  };
  const enter = (d: D, at: number, offAfter: number | null, reminders: number) => {
    Object.assign(d, { status: 'entered', enteredAt: at, remindersSent: reminders });
    engine.log('admin', 'deal_entered', { userId: d.userId, withdrawalId: d.id, at });
    if (offAfter !== null) {
      d.requisiteOffAt = at + offAfter;
      engine.log('admin', 'requisite_off', { userId: d.userId, withdrawalId: d.id, at: d.requisiteOffAt });
    }
    const blocked = !!u(d.userId).botBlockedAt;
    for (let n = 1; n <= reminders; n++) {
      d.reminders.push({ n, at: at + n * 2 * MIN, delivered: !blocked, error: blocked ? 'Пользователь заблокировал бота' : null, reactedAt: null });
      engine.log('system', 'reminder_sent', { userId: d.userId, withdrawalId: d.id, data: { n, delivered: !blocked }, at: at + n * 2 * MIN });
    }
  };
  const archive = (d: D, at: number, resolution: 'closed' | 'confirmed_admin' | 'correction' | 'cancelled', externalId: string | null, reportedRub?: number) => {
    const owner = u(d.userId);
    owner.frozenMicro -= d.amountMicro;
    if (resolution === 'cancelled') {
      owner.availableMicro += d.amountMicro;
      Object.assign(d, { status: 'cancelled', refundedMicro: d.amountMicro });
      engine.log('admin', 'deal_cancelled', { userId: d.userId, withdrawalId: d.id, amountMicro: d.amountMicro, data: { reason: 'исполнитель не вошёл в сделку' }, at });
    } else if (resolution === 'correction') {
      const corrected = Math.ceil((reportedRub! / rate) * 1e6);
      owner.availableMicro += d.amountMicro - corrected;
      Object.assign(d, { status: 'completed', reportedRub, finalRub: reportedRub, debitedMicro: corrected, refundedMicro: d.amountMicro - corrected });
      engine.log('user', 'user_other_amount', { userId: d.userId, withdrawalId: d.id, amountRub: reportedRub, data: { originalRub: d.amountRub }, at: at - 20 * MIN });
      engine.log('admin', 'correction_accepted', { userId: d.userId, withdrawalId: d.id, amountRub: reportedRub, amountMicro: corrected, at });
    } else {
      Object.assign(d, { status: 'completed', finalRub: d.amountRub, debitedMicro: d.amountMicro });
      if (resolution === 'closed') {
        Object.assign(d, { userDecision: 'received', userDecidedAt: at - 3 * MIN, userConfirmedAt: at - 3 * MIN });
        engine.log('user', 'user_received', { userId: d.userId, withdrawalId: d.id, amountMicro: d.amountMicro, at: at - 3 * MIN });
        engine.log('admin', 'deal_closed', { userId: d.userId, withdrawalId: d.id, at });
      } else {
        engine.log('admin', 'admin_confirmed', { userId: d.userId, withdrawalId: d.id, amountMicro: d.amountMicro, at });
      }
    }
    Object.assign(d, { resolution, finishedAt: at, externalId });
    if (externalId) engine.log('admin', 'external_id_set', { userId: d.userId, withdrawalId: d.id, data: { externalId }, at });
  };

  // Archive
  const a1 = add(2, 4000, t0 - 3 * DAY, card('2202206130214876'));
  take(a1, t0 - 3 * DAY + 2 * MIN);
  archive(a1, t0 - 3 * DAY + 30 * MIN, 'cancelled', null);
  const mine = add(1, 3000, t0 - 2 * DAY, sbp('79123456789', '100000000004', 'Т-Банк'));
  take(mine, t0 - 2 * DAY + 2 * MIN);
  enter(mine, t0 - 2 * DAY + 5 * MIN, 40_000, 1);
  archive(mine, t0 - 2 * DAY + 11 * MIN, 'closed', 'P2P-77812');
  const a2 = add(7, 25000, t0 - DAY - 5 * HOUR, sbp('79161112233', '100000000111', 'Сбербанк'));
  take(a2, t0 - DAY - 5 * HOUR + MIN);
  enter(a2, t0 - DAY - 5 * HOUR + 4 * MIN, 30_000, 5);
  archive(a2, t0 - DAY - 4 * HOUR, 'confirmed_admin', 'P2P-77790');
  const a3 = add(9, 7000, t0 - DAY - 2 * HOUR, card('5536913812345678'));
  take(a3, t0 - DAY - 2 * HOUR + MIN);
  enter(a3, t0 - DAY - 2 * HOUR + 3 * MIN, 25_000, 2);
  archive(a3, t0 - DAY - HOUR, 'correction', 'P2P-77801', 6500);

  // Active board
  const inactive = add(9, 12000, t0 - 34 * MIN, card('2200700198765432'));
  take(inactive, t0 - 33 * MIN);
  enter(inactive, t0 - 30 * MIN, 50_000, 5);
  Object.assign(inactive, { status: 'inactive', inactiveSince: t0 - 18 * MIN });
  engine.log('system', 'deal_inactive', { userId: 9, withdrawalId: inactive.id, at: t0 - 18 * MIN });

  const notReceived = add(8, 8000, t0 - 28 * MIN, sbp('79057778899', '110000000005', 'ВТБ'));
  take(notReceived, t0 - 27 * MIN);
  enter(notReceived, t0 - 25 * MIN, 45_000, 5);
  Object.assign(notReceived, { status: 'not_received', userDecision: 'not_received', userDecidedAt: t0 - 14 * MIN });
  engine.log('user', 'user_not_received', { userId: 8, withdrawalId: notReceived.id, amountRub: 8000, at: t0 - 14 * MIN });

  const mismatch = add(4, 50000, t0 - 22 * MIN, sbp('79031234567', '100000000004', 'Т-Банк'));
  take(mismatch, t0 - 21 * MIN);
  enter(mismatch, t0 - 19 * MIN, 35_000, 3);
  Object.assign(mismatch, { status: 'mismatch', userDecision: 'other_amount', userDecidedAt: t0 - 12 * MIN, reportedRub: 49000 });
  engine.log('user', 'user_other_amount', { userId: 4, withdrawalId: mismatch.id, amountRub: 49000, data: { originalRub: 50000 }, at: t0 - 12 * MIN });

  const confirmed = add(7, 30000, t0 - 13 * MIN, card('4276380012345678'));
  take(confirmed, t0 - 12 * MIN);
  enter(confirmed, t0 - 9 * MIN, 50_000, 4);
  owner(confirmed);
  function owner(d: D) {
    Object.assign(d, { status: 'user_confirmed', userDecision: 'received', userDecidedAt: t0 - MIN, userConfirmedAt: t0 - MIN, debitedMicro: d.amountMicro, finalRub: d.amountRub });
    u(d.userId).frozenMicro -= d.amountMicro;
    engine.log('user', 'user_received', { userId: d.userId, withdrawalId: d.id, amountMicro: d.amountMicro, amountRub: d.amountRub, at: t0 - MIN });
  }

  const awaiting = add(6, 10000, t0 - 9 * MIN, sbp('79217776655', '100000000008', 'Альфа-Банк'));
  take(awaiting, t0 - 8 * MIN);
  enter(awaiting, t0 - 5 * MIN, 60_000, 2);

  const requisite = add(5, 15000, t0 - 4 * MIN, sbp('79265554433', '100000000111', 'Сбербанк'));
  take(requisite, t0 - 3 * MIN);
  enter(requisite, t0 - 40_000, null, 0);

  const inWork = add(4, 20000, t0 - 6 * MIN, sbp('79031234567', '100000000004', 'Т-Банк'));
  take(inWork, t0 - 2 * MIN);

  add(2, 15000, t0 - 7 * MIN, card('2202206130214876'));
  add(3, 5000, t0 - 2 * MIN, sbp('79998887766', '100000000111', 'Сбербанк'));

  // Shadow holds: one partly held (the user has less than owed), one fully repaid.
  engine.createObligation({ userId: 7, amountUsdt: 3, comment: 'Переплата 250 ₽ по сделке', withdrawalId: a2.id }, 'admin');
  engine.createObligation({ userId: 2, amountUsdt: 50, comment: 'Переплата 4 500 ₽: исполнитель отправил дважды', withdrawalId: a1.id }, 'admin');

  engine.broadcasts.push({
    id: 1, createdAt: t0 - 2 * DAY, author: 'admin', text: '<b>Технические работы</b>\nСегодня с 02:00 до 02:30 по Москве выводы могут задерживаться.',
    hasPhoto: false, buttonText: null, buttonUrl: null, status: 'done', total: 9, sent: 8, failed: 0, blocked: 1, finishedAt: t0 - 2 * DAY + 4000, errors: [],
  });
}
