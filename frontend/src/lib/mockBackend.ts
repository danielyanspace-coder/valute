// In-browser stand-in for the backend, used only by the standalone demo build.
// Mirrors the server rules (shared/payout.ts) so the whole flow, admin side
// included, can be clicked through without a server or Telegram.
import type {
  AdminCounts,
  AdminUserDto,
  AdminWithdrawalDto,
  AdminWithdrawalListItem,
  CheckDto,
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
  CARD_BRAND_LABEL,
  CONFIRM_WINDOW_MS,
  USDT_MICRO,
  cardBrand,
  formatRuPhone,
  isFinal,
  maskCard,
  nextStatus,
  normalizeRuPhone,
  usdtMicroForRub,
  validateCard,
  validatePayoutRub,
  validateRuPhone,
  type WithdrawalAction,
  type WithdrawalStatus,
} from '../../../shared/payout';
import { findBank } from '../../../shared/sbpBanks';
import { checkLink, cleanComment, isValidUsername, normalizeUsername, parseUsdt } from '../../../shared/transfers';
import { ApiError, type AdminApi, type Api, type MarketCoin, type WalletRate } from './api';

interface MockUser {
  id: number;
  telegramId: number;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string;
  createdAt: number;
  lastSeenAt: number;
  blocked: boolean;
  missedConfirmations: number;
  availableMicro: number;
  frozenMicro: number;
  depositedMicro: number;
  addresses: { chain: string; address: string; createdAt: number }[];
}

interface MockWithdrawal {
  id: number;
  userId: number;
  requestId: string;
  method: 'sbp' | 'card';
  phone: string | null;
  bankId: string | null;
  bankName: string | null;
  cardNumber: string | null;
  amountRub: number;
  amountMicro: number;
  rate: number;
  exchangeRate: number;
  balanceBeforeMicro: number;
  status: WithdrawalStatus;
  createdAt: number;
  sentAt: number | null;
  confirmDeadline: number | null;
  finishedAt: number | null;
  confirmedBy: 'user' | 'auto' | 'admin' | null;
  rejectReason: string | null;
  contactRequestedAt: number | null;
  platform: string;
  events: WithdrawalEventDto[];
}

const fail = (status: number, message: string): never => {
  throw new ApiError(status, 'demo', message);
};
const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 180));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function createMockBackend(snapshot: { rate: WalletRate; coins: MarketCoin[] }) {
  const now = () => Date.now();
  let eventId = 1;
  let notificationId = 1;
  const t0 = now();

  const users: MockUser[] = [
    {
      id: 1, telegramId: 5_210_448_301, username: 'darkfox_ix', firstName: 'DarkFox', lastName: null, languageCode: 'ru',
      createdAt: t0 - 21 * DAY, lastSeenAt: t0, blocked: false, missedConfirmations: 0,
      availableMicro: 250 * USDT_MICRO, frozenMicro: 0, depositedMicro: 400 * USDT_MICRO,
      addresses: [
        { chain: 'TRON', address: 'TQ5NvbPLn7fGQyw3UDcPzC9nK8m2Xh4aRd', createdAt: t0 - 20 * DAY },
        { chain: 'BSC/ETH', address: '0x7a3F9c2E41b8D06e5A1c9F3b2E8d4C6a1B0f9E27', createdAt: t0 - 9 * DAY },
      ],
    },
    {
      id: 2, telegramId: 6_031_877_412, username: null, firstName: 'Иван', lastName: 'К.', languageCode: 'ru',
      createdAt: t0 - 4 * DAY, lastSeenAt: t0 - 12 * MIN, blocked: false, missedConfirmations: 2,
      availableMicro: 31_500_000, frozenMicro: 0, depositedMicro: 220 * USDT_MICRO,
      addresses: [{ chain: 'TRON', address: 'TKr8wqZ3vHcN1mP6sYb2XgD9fJ4tLa7uEe', createdAt: t0 - 4 * DAY }],
    },
    {
      id: 3, telegramId: 7_114_902_518, username: 'masha_k', firstName: 'Маша', lastName: null, languageCode: 'ru',
      createdAt: t0 - 11 * DAY, lastSeenAt: t0 - 3 * MIN, blocked: false, missedConfirmations: 0,
      availableMicro: 74 * USDT_MICRO, frozenMicro: 0, depositedMicro: 120 * USDT_MICRO, addresses: [],
    },
  ];
  interface MockCheck { id: number; code: string; creatorId: number; amountMicro: number; comment: string | null; status: CheckDto['status']; createdAt: number; claimedBy: number | null; claimedAt: number | null }
  interface MockTransfer { id: number; from: number; to: number; amountMicro: number; kind: 'direct' | 'check'; comment: string | null; requestId: string | null; createdAt: number }
  const checks: MockCheck[] = [];
  const transfers: MockTransfer[] = [];
  const BOT = 'cryptoix_bot';
  const withdrawals: MockWithdrawal[] = [];
  const notifications: (NotificationDto & { userId: number; seen: boolean })[] = [];
  let transferId = 1;
  let checkId = 1;

  const ev = (w: MockWithdrawal, actor: WithdrawalEventDto['actor'], type: string, data: Record<string, unknown>, at = now()) =>
    w.events.push({ id: eventId++, at, actor, type, data });

  // Seed history: a finished payout of the demo user and a fresh request from another user.
  const seed = (u: MockUser, p: Partial<MockWithdrawal> & { amountRub: number; createdAt: number }) => {
    const w: MockWithdrawal = {
      id: 1000 + withdrawals.length + 1, userId: u.id, requestId: `seed${withdrawals.length}`, method: 'sbp', phone: null,
      bankId: null, bankName: null, cardNumber: null, rate: snapshot.rate.walletRate, exchangeRate: snapshot.rate.walletRate / 1.05,
      amountMicro: usdtMicroForRub(p.amountRub, snapshot.rate.walletRate), balanceBeforeMicro: u.availableMicro, status: 'pending',
      sentAt: null, confirmDeadline: null, finishedAt: null, confirmedBy: null, rejectReason: null, contactRequestedAt: null,
      platform: 'ios', events: [], ...p,
    };
    withdrawals.push(w);
    ev(w, 'user', 'created', { amountRub: w.amountRub, amountMicro: w.amountMicro, rate: w.rate }, w.createdAt);
    return w;
  };
  const done = seed(users[0], {
    amountRub: 3000, method: 'sbp', phone: '79123456789', bankId: '100000000004', bankName: 'Т-Банк', createdAt: t0 - 2 * DAY,
  });
  Object.assign(done, { status: 'completed', sentAt: t0 - 2 * DAY + 6 * MIN, finishedAt: t0 - 2 * DAY + 9 * MIN, confirmedBy: 'user' });
  ev(done, 'admin', 'marked_sent', { deadline: done.sentAt! + CONFIRM_WINDOW_MS }, done.sentAt!);
  ev(done, 'user', 'confirmed', { by: 'user', previousStatus: 'sent' }, done.finishedAt!);
  const pend = seed(users[1], { amountRub: 15000, method: 'card', cardNumber: '2202206130214876', createdAt: t0 - 7 * MIN });
  users[1].frozenMicro = pend.amountMicro;

  const user = (id: number) => users.find((u) => u.id === id) ?? fail(404, 'Пользователь не найден');
  const wd = (id: number) => withdrawals.find((w) => w.id === id) ?? fail(404, 'Заявка не найдена');

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

  const move = (w: MockWithdrawal, action: WithdrawalAction) => {
    const to = nextStatus(w.status, action);
    if (!to) fail(409, 'Действие недоступно в текущем статусе');
    const from = w.status;
    w.status = to!;
    return from;
  };

  const complete = (w: MockWithdrawal, action: WithdrawalAction) => {
    const by = action === 'confirm_user' ? 'user' : action === 'confirm_auto' ? 'auto' : 'admin';
    const prev = move(w, action);
    const u = user(w.userId);
    u.frozenMicro -= w.amountMicro;
    w.finishedAt = now();
    w.confirmedBy = by;
    ev(w, by === 'user' ? 'user' : by === 'auto' ? 'system' : 'admin', 'confirmed', { by, previousStatus: prev });
    if (by === 'auto') u.missedConfirmations++;
    if (by !== 'user') notify(u.id, 'withdrawal_completed', w.id);
  };

  setInterval(() => {
    for (const w of withdrawals) if (w.status === 'sent' && w.confirmDeadline! <= now()) complete(w, 'confirm_auto');
  }, 3000);

  const destination = (w: MockWithdrawal) =>
    w.method === 'sbp'
      ? `${formatRuPhone(w.phone ?? '')} · ${w.bankName}`
      : `${CARD_BRAND_LABEL[cardBrand(w.cardNumber ?? '')] || 'Карта'} ${maskCard(w.cardNumber ?? '')}`;

  const userDto = (w: MockWithdrawal): WithdrawalDto => ({
    id: w.id, method: w.method, status: w.status, amountRub: w.amountRub, amountMicro: w.amountMicro, rate: w.rate,
    destination: destination(w), createdAt: w.createdAt, sentAt: w.sentAt, confirmDeadline: w.confirmDeadline,
    finishedAt: w.finishedAt, confirmedBy: w.confirmedBy, rejectReason: w.rejectReason, serverNow: now(),
  });

  const listItem = (w: MockWithdrawal): AdminWithdrawalListItem => {
    const u = user(w.userId);
    return {
      id: w.id, status: w.status, method: w.method, amountRub: w.amountRub, amountMicro: w.amountMicro,
      destination: destination(w), createdAt: w.createdAt, confirmDeadline: w.confirmDeadline,
      user: { id: u.id, username: u.username, firstName: u.firstName },
    };
  };

  const adminUser = (id: number): AdminUserDto => {
    const u = user(id);
    const mine = withdrawals.filter((w) => w.userId === id);
    const completed = mine.filter((w) => w.status === 'completed');
    return {
      id: u.id, telegramId: u.telegramId, username: u.username, firstName: u.firstName, lastName: u.lastName, photoUrl: null,
      languageCode: u.languageCode, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, blocked: u.blocked,
      missedConfirmations: u.missedConfirmations, availableMicro: u.availableMicro, frozenMicro: u.frozenMicro,
      depositAddresses: u.addresses,
      stats: {
        depositedMicro: u.depositedMicro,
        withdrawnRub: completed.reduce((s, w) => s + w.amountRub, 0),
        withdrawnMicro: completed.reduce((s, w) => s + w.amountMicro, 0),
        withdrawalsTotal: mine.length,
        withdrawalsCompleted: completed.length,
        disputes: mine.filter((w) => w.events.some((e) => e.type === 'disputed')).length,
        transfersInMicro: transfers.filter((t) => t.to === id).reduce((a, t) => a + t.amountMicro, 0),
        transfersOutMicro: transfers.filter((t) => t.from === id).reduce((a, t) => a + t.amountMicro, 0),
        activeChecksMicro: checks.filter((c) => c.creatorId === id && c.status === 'active').reduce((a, c) => a + c.amountMicro, 0),
      },
    };
  };

  const adminGet = (id: number): AdminWithdrawalDto => {
    const w = wd(id);
    const same = new Map<number, number>();
    for (const o of withdrawals) {
      if (o.userId === w.userId) continue;
      if ((w.phone && o.phone === w.phone) || (w.cardNumber && o.cardNumber === w.cardNumber)) {
        same.set(o.userId, (same.get(o.userId) ?? 0) + 1);
      }
    }
    return {
      ...listItem(w),
      phone: w.phone, bankId: w.bankId, bankName: w.bankName, cardNumber: w.cardNumber,
      cardBrand: w.cardNumber ? CARD_BRAND_LABEL[cardBrand(w.cardNumber)] : null,
      rate: w.rate, exchangeRate: w.exchangeRate, balanceBeforeMicro: w.balanceBeforeMicro, sentAt: w.sentAt,
      finishedAt: w.finishedAt, confirmedBy: w.confirmedBy, rejectReason: w.rejectReason,
      contactRequestedAt: w.contactRequestedAt, clientIp: '185.12.64.7 (демо)', userAgent: 'Telegram iOS 11.2 (демо)',
      platform: w.platform, events: w.events, userDetails: adminUser(w.userId),
      sameDestinationUsers: [...same].map(([uid, n]) => {
        const u = user(uid);
        return { id: u.id, username: u.username, firstName: u.firstName, withdrawals: n };
      }),
      recentWithdrawals: withdrawals.filter((o) => o.userId === w.userId && o.id !== w.id).reverse().map(listItem),
      serverNow: now(),
    };
  };

  const me = users[0];

  const contactLock = (userId: number) => {
    const w = [...withdrawals].reverse().find((x) => x.userId === userId && x.contactRequestedAt && !isFinal(x.status));
    return w ? { withdrawalId: w.id, amountRub: w.amountRub } : null;
  };
  const assertNotLocked = (userId: number) => {
    if (contactLock(userId)) fail(423, 'Кошелёк временно недоступен. Свяжитесь с поддержкой, чтобы завершить заявку');
  };

  const api: Api = {
    rate: () => delay(snapshot.rate),
    market: () => delay({ coins: snapshot.coins }),
    me: (): Promise<MeDto> =>
      delay({
        user: { id: me.id, telegramId: me.telegramId, username: me.username, firstName: me.firstName, lastName: me.lastName, photoUrl: null },
        availableMicro: me.availableMicro, frozenMicro: me.frozenMicro, blocked: me.blocked, supportUsername: 'cryptoix_support',
        contactLock: contactLock(me.id),
        botUsername: BOT,
      }),
    withdrawals: () => delay({ items: withdrawals.filter((w) => w.userId === me.id).reverse().map(userDto) }),
    withdrawal: (id) => {
      const w = wd(id);
      if (w.userId !== me.id) fail(404, 'Заявка не найдена');
      return delay(userDto(w));
    },
    createWithdrawal: (req: CreateWithdrawalRequest) => {
      const dup = withdrawals.find((w) => w.userId === me.id && w.requestId === req.requestId);
      if (dup) return delay(userDto(dup));
      if (me.blocked) fail(403, 'Вывод недоступен. Свяжитесь с поддержкой');
      assertNotLocked(me.id);
      const amountError = validatePayoutRub(req.amountRub);
      if (amountError) fail(400, amountError);
      if (req.method === 'sbp') {
        const e = validateRuPhone(req.phone ?? '');
        if (e) fail(400, e);
        if (!findBank(req.bankId ?? '')) fail(400, 'Выберите банк');
      } else {
        const e = validateCard(req.cardNumber ?? '');
        if (e) fail(400, e);
      }
      const amountMicro = usdtMicroForRub(req.amountRub, snapshot.rate.walletRate);
      if (amountMicro > me.availableMicro) fail(400, 'Недостаточно средств');
      const w: MockWithdrawal = {
        id: 1000 + withdrawals.length + 1, userId: me.id, requestId: req.requestId, method: req.method,
        phone: req.method === 'sbp' ? normalizeRuPhone(req.phone!) : null,
        bankId: req.method === 'sbp' ? req.bankId! : null,
        bankName: req.method === 'sbp' ? findBank(req.bankId!)!.name : null,
        cardNumber: req.method === 'card' ? req.cardNumber!.replace(/\D/g, '') : null,
        amountRub: req.amountRub, amountMicro, rate: snapshot.rate.walletRate, exchangeRate: snapshot.rate.walletRate / 1.05,
        balanceBeforeMicro: me.availableMicro, status: 'pending', createdAt: now(), sentAt: null, confirmDeadline: null,
        finishedAt: null, confirmedBy: null, rejectReason: null, contactRequestedAt: null, platform: 'demo', events: [],
      };
      me.availableMicro -= amountMicro;
      me.frozenMicro += amountMicro;
      withdrawals.push(w);
      ev(w, 'user', 'created', { amountRub: w.amountRub, amountMicro, rate: w.rate });
      return delay(userDto(w));
    },
    confirmWithdrawal: (id) => {
      complete(wd(id), 'confirm_user');
      return delay(userDto(wd(id)));
    },
    disputeWithdrawal: (id) => {
      const w = wd(id);
      move(w, 'dispute');
      ev(w, 'user', 'disputed', { username: user(w.userId).username });
      return delay(userDto(w));
    },
    notifications: () =>
      delay({
        items: notifications
          .filter((n) => n.userId === me.id && !n.seen)
          .map(({ id, type, withdrawalId, createdAt, transfer, check }) => ({ id, type, withdrawalId, createdAt, transfer, check })),
      }),
    markNotificationsSeen: (ids) => {
      for (const n of notifications) if (ids.includes(n.id)) n.seen = true;
      return delay({ ok: true });
    },
    history: () => {
      const items: HistoryItem[] = [
        ...withdrawals.filter((w) => w.userId === me.id).map((w): HistoryItem => ({ type: 'withdrawal', at: w.createdAt, withdrawal: userDto(w) })),
        ...transfers
          .filter((t) => t.to === me.id || (t.from === me.id && t.kind === 'direct'))
          .map((t): HistoryItem => ({ type: 'transfer', at: t.createdAt, transfer: transferDto(t, me.id) })),
        ...checks.filter((c) => c.creatorId === me.id).map((c): HistoryItem => ({ type: 'check', at: c.createdAt, check: checkDto(c) })),
      ];
      return delay({ items: items.sort((a, b) => b.at - a.at) });
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
      to.availableMicro += amountMicro;
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
      me.availableMicro += c.amountMicro;
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
      friend.availableMicro += c.amountMicro;
      transfers.push({ id: transferId++, from: c.creatorId, to: friend.id, amountMicro: c.amountMicro, kind: 'check', comment: c.comment, requestId: null, createdAt: now() });
      notify(c.creatorId, 'check_claimed', null, { check: checkDto(c) });
      return delay({ ok: true });
    },
  };

  // Demo: a friend sends the user a little USDT a few seconds after opening, to show the incoming notice.
  setTimeout(() => {
    const t: MockTransfer = { id: transferId++, from: users[2].id, to: me.id, amountMicro: 15 * USDT_MICRO, kind: 'direct', comment: 'Возвращаю за обед', requestId: null, createdAt: now() };
    users[2].availableMicro -= t.amountMicro;
    me.availableMicro += t.amountMicro;
    transfers.push(t);
    notify(me.id, 'transfer_received', null, { transfer: transferDto(t, me.id) });
  }, 4000);

  const counts = (): AdminCounts => {
    const c: AdminCounts = { pending: 0, sent: 0, disputed: 0, completed: 0, rejected: 0 };
    for (const w of withdrawals) c[w.status]++;
    return c;
  };

  const admin: AdminApi = {
    list: (status) =>
      delay({
        items: withdrawals.filter((w) => status === 'all' || w.status === status).reverse().map(listItem),
        counts: counts(),
      }),
    get: (id) => delay(adminGet(id)),
    markSent: (id) => {
      const w = wd(id);
      const resend = w.status === 'disputed';
      move(w, 'mark_sent');
      w.sentAt = now();
      w.confirmDeadline = now() + CONFIRM_WINDOW_MS;
      ev(w, 'admin', 'marked_sent', { deadline: w.confirmDeadline, resend });
      notify(w.userId, 'confirm_receipt', w.id);
      return delay(adminGet(id));
    },
    confirm: (id) => {
      complete(wd(id), 'confirm_admin');
      return delay(adminGet(id));
    },
    reject: (id, reason) => {
      if (!reason.trim()) fail(400, 'Укажите причину отклонения');
      const w = wd(id);
      move(w, 'reject');
      const u = user(w.userId);
      u.frozenMicro -= w.amountMicro;
      u.availableMicro += w.amountMicro;
      w.finishedAt = now();
      w.rejectReason = reason.trim();
      ev(w, 'admin', 'rejected', { reason: w.rejectReason });
      notify(u.id, 'withdrawal_rejected', w.id);
      return delay(adminGet(id));
    },
    requestContact: (id) => {
      const w = wd(id);
      if (isFinal(w.status)) fail(409, 'Заявка уже завершена');
      w.contactRequestedAt = now();
      ev(w, 'admin', 'contact_requested', {});
      notify(w.userId, 'contact_support', w.id);
      return delay(adminGet(id));
    },
    note: (id, text) => {
      if (!text.trim()) fail(400, 'Пустая заметка');
      ev(wd(id), 'admin', 'note', { text: text.trim() });
      return delay(adminGet(id));
    },
    adjustBalance: (userId, amountUsdt, comment) => {
      if (!comment.trim()) fail(400, 'Укажите причину корректировки');
      const micro = Math.round(amountUsdt * USDT_MICRO);
      if (!micro) fail(400, 'Укажите сумму');
      const u = user(userId);
      if (u.availableMicro + micro < 0) fail(400, 'Баланс не может стать отрицательным');
      u.availableMicro += micro;
      return delay(adminUser(userId));
    },
    setBlocked: (userId, blocked) => {
      user(userId).blocked = blocked;
      return delay(adminUser(userId));
    },
  };

  return { api, admin };
}
