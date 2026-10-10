import { describe, expect, it } from 'vitest';
import { DEPOSIT_QUARANTINE_MS, DEPOSIT_REQUEST_TTL_MS } from '../../../shared/deposits.js';
import { AmlService } from '../aml/amlService.js';
import type { AmlCheck, AmlSignal } from '../aml/types.js';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo } from '../users/userRepo.js';
import { DepositService, POLL_SCHEDULE } from './depositService.js';
import type { IncomingTransfer, TronChain, TxVerdict } from './tronClient.js';

const A1 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const A2 = 'TYr4DLeAY4S7g9FkQQGvo8DmyPDvzb8HWq';
const OWN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SENDER = 'TKr8wqZ3vHcN1mP6sYb2XgD9fJ4tLa7uEe';
const SENDER2 = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
const USDT = 1_000_000;
const MIN = 60_000;

class FakeChain implements TronChain {
  incoming = new Map<string, IncomingTransfer[]>();
  verdicts = new Map<string, TxVerdict>();
  calls = 0;
  async incomingUsdt(address: string): Promise<IncomingTransfer[]> {
    this.calls++;
    return this.incoming.get(address) ?? [];
  }
  async verifyUsdtTo(txId: string): Promise<TxVerdict> {
    return this.verdicts.get(txId) ?? { state: 'unconfirmed' };
  }
  balances = new Map<string, number>();
  failing = new Set<string>();
  async balance(address: string) {
    if (this.failing.has(address)) throw new Error('TronGrid 503');
    return { usdtMicro: this.balances.get(address) ?? 0, trxSun: 0 };
  }
  /** A transfer seen by the index and already confirmed by the chain. */
  pay(to: string, txId: string, valueMicro: number, at: number, from = SENDER, confirmed = true) {
    this.incoming.set(to, [...(this.incoming.get(to) ?? []), { txId, from, valueMicro, blockTimestamp: at }]);
    if (confirmed) this.verdicts.set(txId, { state: 'confirmed', valueMicro, from, blockNumber: 1, blockTimestamp: at });
  }
}

class FakeAml implements AmlCheck {
  readonly source = 'fake';
  flagged = new Set<string>();
  broken = false;
  supports() {
    return true;
  }
  async check(_c: unknown, address: string): Promise<AmlSignal> {
    if (this.broken) throw new Error('rpc down');
    return { source: this.source, hit: this.flagged.has(address) };
  }
}

function setup(addresses = [A1, A2]) {
  let now = 10_000_000;
  const clock = () => now;
  const db = openDatabase(':memory:');
  const users = new UserRepo(db, clock);
  const ann = users.upsertFromTelegram({ id: 42, first_name: 'Ann' });
  const bob = users.upsertFromTelegram({ id: 43, first_name: 'Bob' });
  const cat = users.upsertFromTelegram({ id: 44, first_name: 'Cat' });
  const ledger = new Ledger(db, clock);
  const sent: string[] = [];
  const notifications = new NotificationService(db, { send: async (_id, text) => void sent.push(text) }, undefined, clock);
  const chain = new FakeChain();
  const amlCheck = new FakeAml();
  const svc = new DepositService(db, chain, new AmlService([amlCheck], clock), ledger, users, notifications, { minDepositMicro: 10 * USDT, batchSize: 10 }, clock);
  for (const a of addresses) svc.poolAdd(a, '', false);
  const run = async () => {
    now += POLL_SCHEDULE.idle; // everything is due
    await svc.tick();
  };
  const balance = (id: number) => ledger.balances(id).availableMicro;
  return { db, ann, bob, cat, ledger, notifications, chain, amlCheck, svc, sent, run, balance, now: () => now, advance: (ms: number) => (now += ms) };
}

describe('DepositService: requests', () => {
  it('lends a free address, one request per user', () => {
    const t = setup();
    expect(t.svc.enabled()).toBe(true);
    const r = t.svc.open(t.ann.id);
    expect(r.address).toBe(A1);
    expect(r.expiresAt - r.createdAt).toBe(DEPOSIT_REQUEST_TTL_MS);
    expect(() => t.svc.open(t.ann.id)).toThrow(/отмените/);
    expect(t.svc.open(t.bob.id).address).toBe(A2);
  });

  it('keeps an address away from others during the quarantine, but gives it back to its holder', () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.svc.cancel(t.ann.id);
    expect(t.svc.current(t.ann.id)).toBeNull();
    expect(t.svc.open(t.bob.id).address).toBe(A2);
    expect(t.svc.open(t.ann.id).address).toBe(A1); // her own, still in quarantine
  });

  it('says when an address frees up if all are taken', () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.svc.open(t.bob.id);
    let err: any;
    try {
      t.svc.open(t.cat.id);
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe('pool_busy');
    expect(err.extra.retryAt).toBe(t.now() + DEPOSIT_REQUEST_TTL_MS + DEPOSIT_QUARANTINE_MS);

    t.advance(DEPOSIT_REQUEST_TTL_MS);
    expect(t.svc.current(t.ann.id)?.status).toBe('expired');
    expect(() => t.svc.open(t.cat.id)).toThrow(/заняты/); // quarantine
    t.advance(DEPOSIT_QUARANTINE_MS);
    expect(t.svc.open(t.cat.id).address).toBe(A1);
  });

  it('switched off and own addresses are never lent', () => {
    const t = setup([A1]);
    t.svc.poolAdd(OWN, 'основной', true);
    const id = t.svc.poolList().find((p) => p.address === A1)!.id;
    t.svc.poolUpdate(id, { enabled: false });
    expect(t.svc.enabled()).toBe(false);
    expect(() => t.svc.open(t.ann.id)).toThrow(/заняты/);
  });

  it('refuses bad, duplicate and used addresses', () => {
    const t = setup([A1]);
    expect(() => t.svc.poolAdd('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdh', '', false)).toThrow(/не адрес/);
    expect(() => t.svc.poolAdd(A1, '', false)).toThrow(/уже добавлен/);
    t.svc.open(t.ann.id);
    expect(() => t.svc.poolRemove(t.svc.poolList()[0].id)).toThrow(/выключить/);
    expect(t.svc.poolList()[0]).toMatchObject({ state: 'busy', holder: { id: t.ann.id } });
  });
});

describe('DepositService: attribution', () => {
  it('credits what arrives during the request to its holder, exactly once', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'tx1', 25 * USDT, t.now() + MIN, SENDER, false);
    await t.run();
    expect(t.svc.current(t.ann.id)).toMatchObject({ status: 'paid', receivedMicro: 25 * USDT });
    expect(t.balance(t.ann.id)).toBe(0); // not confirmed yet

    t.chain.verdicts.set('tx1', { state: 'confirmed', valueMicro: 25 * USDT, from: SENDER, blockNumber: 1, blockTimestamp: t.now() });
    await t.run();
    expect(t.balance(t.ann.id)).toBe(25 * USDT);
    expect(t.sent).toEqual(['💰 <b>Пополнение +25 USDT</b>\nЗачислено на баланс.']);
    expect(t.svc.current(t.ann.id)?.creditedMicro).toBe(25 * USDT);
    await t.run();
    expect(t.balance(t.ann.id)).toBe(25 * USDT);
    expect(t.svc.listForUser(t.ann.id)).toHaveLength(1);
  });

  it('credits a late transfer during the quarantine automatically', async () => {
    const t = setup();
    const r = t.svc.open(t.ann.id);
    t.chain.pay(A1, 'late', 40 * USDT, r.expiresAt + 20 * MIN);
    await t.run();
    expect(t.balance(t.ann.id)).toBe(40 * USDT);
    expect(t.svc.adminList('credited')[0]).toMatchObject({ late: true, requestId: r.id, user: { id: t.ann.id } });
  });

  it('sends a transfer nobody can claim to the operator', async () => {
    const t = setup();
    const r = t.svc.open(t.ann.id);
    t.chain.pay(A1, 'orphan', 30 * USDT, r.expiresAt + DEPOSIT_QUARANTINE_MS + MIN);
    await t.run();
    const d = t.svc.adminList('held')[0];
    expect(d).toMatchObject({ review: 'unidentified', user: null, issuedTo: null });
    expect(() => t.svc.creditByAdmin(d.id, null)).toThrow(/кому/);
    t.svc.creditByAdmin(d.id, 'написал в поддержку', t.bob.id);
    expect(t.balance(t.bob.id)).toBe(30 * USDT);
  });

  it('flags a known sender on an address nobody held, with the linked account', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'first', 20 * USDT, t.now() + MIN);
    await t.run();
    expect(t.balance(t.ann.id)).toBe(20 * USDT);

    t.chain.pay(A2, 'second', 50 * USDT, t.now()); // A2 was never lent
    await t.run();
    const d = t.svc.adminList('held')[0];
    expect(d.review).toBe('linked_sender');
    expect(d.senderUsers.map((u) => u.id)).toEqual([t.ann.id]);
    expect(t.balance(t.ann.id)).toBe(20 * USDT);
  });

  it('flags a sender that belongs to someone else than the holder', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'ann', 20 * USDT, t.now() + MIN);
    await t.run();

    t.svc.open(t.bob.id); // gets A2
    t.chain.pay(A2, 'bob?', 70 * USDT, t.now() + MIN); // from Ann's wallet
    await t.run();
    const d = t.svc.adminList('held')[0];
    expect(d).toMatchObject({ review: 'sender_conflict', user: { id: t.bob.id }, issuedTo: { id: t.bob.id } });
    expect(d.senderUsers.map((u) => u.id)).toEqual([t.ann.id]);
    expect(t.balance(t.bob.id)).toBe(0);
  });

  it('ignores the link once a wallet is shared by several users (exchange)', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'a', 20 * USDT, t.now() + MIN);
    await t.run();
    t.svc.open(t.bob.id);
    t.chain.pay(A2, 'b', 20 * USDT, t.now() + MIN);
    await t.run();
    t.svc.creditByAdmin(t.svc.adminList('held')[0].id, 'та же биржа'); // goes to Bob, the holder
    expect(t.balance(t.bob.id)).toBe(20 * USDT);

    t.advance(DEPOSIT_QUARANTINE_MS);
    t.svc.open(t.cat.id);
    t.chain.pay(t.svc.current(t.cat.id)!.address, 'c', 20 * USDT, t.now() + MIN);
    await t.run();
    expect(t.balance(t.cat.id)).toBe(20 * USDT);
  });

  it('does not count transfers from own wallets', async () => {
    const t = setup();
    t.svc.poolAdd(OWN, 'основной', true);
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'mine', 500 * USDT, t.now() + MIN, OWN);
    t.chain.pay(A1, 'pool', 300 * USDT, t.now() + MIN, A2);
    await t.run();
    expect(t.svc.adminList('all')).toHaveLength(0);
    expect(t.svc.current(t.ann.id)?.status).toBe('active');
  });
});

describe('DepositService: checks', () => {
  it('trusts the chain amount over the index', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'tx1', 1000 * USDT, t.now() + MIN, SENDER, false); // index lies
    t.chain.verdicts.set('tx1', { state: 'confirmed', valueMicro: 12 * USDT, from: SENDER, blockNumber: 1, blockTimestamp: t.now() + MIN });
    await t.run();
    expect(t.balance(t.ann.id)).toBe(12 * USDT);
  });

  it('ignores dust and drops failed transactions', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'dust', 100, t.now() + MIN);
    t.chain.pay(A1, 'fake', 50 * USDT, t.now() + MIN, SENDER2, false);
    t.chain.verdicts.set('fake', { state: 'failed' });
    await t.run();
    expect(t.svc.listForUser(t.ann.id)).toHaveLength(0);
    expect(t.balance(t.ann.id)).toBe(0);
  });

  it('keeps small deposits aside; an operator can credit them', async () => {
    const t = setup();
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'tx1', 5 * USDT, t.now() + MIN);
    await t.run();
    const d = t.svc.listForUser(t.ann.id)[0];
    expect(d.status).toBe('below_min');
    t.svc.creditByAdmin(d.id, 'по просьбе клиента');
    expect(t.balance(t.ann.id)).toBe(5 * USDT);
    expect(() => t.svc.creditByAdmin(d.id, null)).toThrow(/уже обработано/);
  });

  it('holds deposits from flagged senders', async () => {
    const t = setup();
    t.amlCheck.flagged.add(SENDER);
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'tx1', 100 * USDT, t.now() + MIN);
    await t.run();
    const d = t.svc.adminList('held')[0];
    expect(d).toMatchObject({ amlDecision: 'reject', review: 'aml' });
    expect(() => t.svc.rejectByAdmin(d.id, ' ')).toThrow(/причину/);
    expect(t.svc.rejectByAdmin(d.id, 'санкционный адрес').status).toBe('rejected');
    expect(t.svc.adminCounts()).toMatchObject({ held: 0, rejected: 1 });
  });

  it('retries AML that could not run, then holds', async () => {
    const t = setup();
    t.amlCheck.broken = true;
    t.svc.open(t.ann.id);
    t.chain.pay(A1, 'tx1', 100 * USDT, t.now() + MIN);
    await t.run();
    expect(t.svc.listForUser(t.ann.id)[0].status).toBe('pending');
    t.advance(31 * MIN);
    await t.run();
    expect(t.svc.listForUser(t.ann.id)[0].status).toBe('held');
  });

  it('polls a lent address often and a free one rarely', async () => {
    const t = setup([A1]);
    await t.svc.tick();
    expect(t.chain.calls).toBe(1);
    t.advance(POLL_SCHEDULE.hot);
    await t.svc.tick(); // free: not due
    expect(t.chain.calls).toBe(1);
    t.svc.open(t.ann.id);
    await t.svc.tick(); // lent: hot
    expect(t.chain.calls).toBe(2);
    t.advance(POLL_SCHEDULE.hot);
    await t.svc.tick();
    expect(t.chain.calls).toBe(3);
  });
});

describe('DepositService: balances on all wallets', () => {
  it('sums every pool address and own wallet, split into pool and own', async () => {
    const t = setup();
    t.svc.poolAdd(OWN, 'основной', true);
    t.chain.balances.set(A1, 120 * USDT).set(A2, 30 * USDT).set(OWN, 1000 * USDT);
    const b = await t.svc.walletBalances();
    expect(b).toMatchObject({ totalUsdtMicro: 1150 * USDT, poolUsdtMicro: 150 * USDT, ownUsdtMicro: 1000 * USDT, failed: 0 });
    expect(b.items.map((i) => [i.address, i.usdtMicro])).toEqual([[OWN, 1000 * USDT], [A1, 120 * USDT], [A2, 30 * USDT]]);
  });

  it('reads the chain at most once a minute unless asked to refresh', async () => {
    const t = setup();
    t.chain.balances.set(A1, 5 * USDT);
    expect((await t.svc.walletBalances()).totalUsdtMicro).toBe(5 * USDT);
    t.chain.balances.set(A1, 7 * USDT);
    expect((await t.svc.walletBalances()).totalUsdtMicro).toBe(5 * USDT);
    expect((await t.svc.walletBalances(true)).totalUsdtMicro).toBe(7 * USDT);
    t.chain.balances.set(A1, 9 * USDT);
    t.advance(61_000);
    expect((await t.svc.walletBalances()).totalUsdtMicro).toBe(9 * USDT);
  });

  it('a wallet TronGrid cannot read keeps its last known balance and is reported', async () => {
    const t = setup();
    t.chain.balances.set(A1, 10 * USDT).set(A2, 20 * USDT);
    await t.svc.walletBalances();
    t.chain.failing.add(A2);
    const b = await t.svc.walletBalances(true);
    expect(b.failed).toBe(1);
    expect(b.totalUsdtMicro).toBe(30 * USDT);
    expect(b.items.find((i) => i.address === A2)).toMatchObject({ usdtMicro: 20 * USDT, error: 'TronGrid 503' });
  });
});
