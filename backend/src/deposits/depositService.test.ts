import { describe, expect, it } from 'vitest';
import { AmlService } from '../aml/amlService.js';
import type { AmlCheck, AmlSignal } from '../aml/types.js';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo } from '../users/userRepo.js';
import { DepositService, POLL_SCHEDULE } from './depositService.js';
import type { IncomingTransfer, TronChain, TxVerdict } from './tronClient.js';

const ADDR = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const SENDER = 'TYr4DLeAY4S7g9FkQQGvo8DmyPDvzb8HWq';
const USDT = 1_000_000;

class FakeChain implements TronChain {
  incoming: IncomingTransfer[] = [];
  verdicts = new Map<string, TxVerdict>();
  calls = 0;
  async incomingUsdt(address: string): Promise<IncomingTransfer[]> {
    this.calls++;
    return address === ADDR ? this.incoming : [];
  }
  async verifyUsdtTo(txId: string): Promise<TxVerdict> {
    return this.verdicts.get(txId) ?? { state: 'unconfirmed' };
  }
  send(txId: string, valueMicro: number, from = SENDER) {
    this.incoming.push({ txId, from, valueMicro, blockTimestamp: 1_000 });
  }
  confirm(txId: string, valueMicro: number, from = SENDER) {
    this.verdicts.set(txId, { state: 'confirmed', valueMicro, from, blockNumber: 1, blockTimestamp: 1_000 });
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

function setup() {
  let now = 10_000_000;
  const clock = () => now;
  const db = openDatabase(':memory:');
  const users = new UserRepo(db, clock);
  const user = users.upsertFromTelegram({ id: 42, first_name: 'Ann' });
  db.prepare("INSERT INTO deposit_addresses (user_id, chain, address, derivation_index, created_at) VALUES (?, 'TRON', ?, 0, ?)").run(user.id, ADDR, now);
  const ledger = new Ledger(db, clock);
  const sent: string[] = [];
  const notifications = new NotificationService(db, { send: async (_id, text) => void sent.push(text) }, undefined, clock);
  const chain = new FakeChain();
  const amlCheck = new FakeAml();
  const svc = new DepositService(db, chain, new AmlService([amlCheck], clock), ledger, users, notifications, { minDepositMicro: 10 * USDT, batchSize: 10 }, clock);
  return { db, user, ledger, notifications, chain, amlCheck, svc, sent, advance: (ms: number) => (now += ms) };
}

describe('DepositService', () => {
  it('credits only after the solidified chain confirms, exactly once', async () => {
    const t = setup();
    t.chain.send('tx1', 25 * USDT);
    await t.svc.tick();
    expect(t.svc.listForUser(t.user.id)[0].status).toBe('pending');
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(0);

    t.chain.confirm('tx1', 25 * USDT);
    t.advance(POLL_SCHEDULE.hot);
    await t.svc.tick();
    expect(t.svc.listForUser(t.user.id)[0].status).toBe('credited');
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(25 * USDT);
    expect(t.notifications.unseen(t.user.id).map((n) => n.type)).toEqual(['deposit_credited']);
    expect(t.sent).toEqual(['Пополнение +25 USDT зачислено на баланс.']);

    t.advance(POLL_SCHEDULE.cold);
    await t.svc.tick();
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(25 * USDT);
    expect(t.svc.listForUser(t.user.id)).toHaveLength(1);
  });

  it('trusts the chain amount over the index', async () => {
    const t = setup();
    t.chain.send('tx1', 1000 * USDT); // index lies
    t.chain.confirm('tx1', 12 * USDT);
    await t.svc.tick();
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(12 * USDT);
  });

  it('ignores spam dust', async () => {
    const t = setup();
    t.chain.send('dust', 100);
    t.chain.confirm('dust', 100);
    await t.svc.tick();
    expect(t.svc.adminList('all')).toHaveLength(0);
  });

  it('drops failed transactions and fake transfers', async () => {
    const t = setup();
    t.chain.send('tx1', 50 * USDT);
    t.chain.verdicts.set('tx1', { state: 'failed' });
    await t.svc.tick();
    expect(t.svc.listForUser(t.user.id)).toHaveLength(0);
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(0);
  });

  it('keeps small deposits aside; an operator can credit them', async () => {
    const t = setup();
    t.chain.send('tx1', 5 * USDT);
    t.chain.confirm('tx1', 5 * USDT);
    await t.svc.tick();
    const d = t.svc.listForUser(t.user.id)[0];
    expect(d.status).toBe('below_min');
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(0);
    t.svc.creditByAdmin(d.id, 'по просьбе клиента');
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(5 * USDT);
    expect(() => t.svc.creditByAdmin(d.id, null)).toThrow(/уже обработано/);
  });

  it('holds deposits from flagged senders', async () => {
    const t = setup();
    t.amlCheck.flagged.add(SENDER);
    t.chain.send('tx1', 100 * USDT);
    t.chain.confirm('tx1', 100 * USDT);
    await t.svc.tick();
    const d = t.svc.adminList('held')[0];
    expect(d.amlDecision).toBe('reject');
    expect(t.ledger.balances(t.user.id).availableMicro).toBe(0);
    expect(() => t.svc.rejectByAdmin(d.id, ' ')).toThrow(/причину/);
    expect(t.svc.rejectByAdmin(d.id, 'санкционный адрес').status).toBe('rejected');
    expect(t.svc.adminCounts()).toMatchObject({ held: 0, rejected: 1 });
  });

  it('retries AML that could not run, then holds', async () => {
    const t = setup();
    t.amlCheck.broken = true;
    t.chain.send('tx1', 100 * USDT);
    t.chain.confirm('tx1', 100 * USDT);
    await t.svc.tick();
    expect(t.svc.listForUser(t.user.id)[0].status).toBe('pending');
    t.advance(31 * 60_000);
    await t.svc.tick();
    expect(t.svc.listForUser(t.user.id)[0].status).toBe('held');
  });

  it('polls often right after the deposit screen is opened, rarely otherwise', async () => {
    const t = setup();
    await t.svc.tick();
    expect(t.chain.calls).toBe(1);
    t.advance(2 * 3600_000);
    await t.svc.tick(); // last view was 2h ago: warm schedule, overdue
    expect(t.chain.calls).toBe(2);
    t.advance(POLL_SCHEDULE.hot);
    await t.svc.tick(); // not due yet
    expect(t.chain.calls).toBe(2);
    t.svc.markViewed(t.user.id);
    await t.svc.tick(); // hot again
    expect(t.chain.calls).toBe(3);
  });
});
