import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { Ledger } from '../ledger/ledger.js';
import { NotificationService } from '../notifications/notificationService.js';
import { UserRepo } from '../users/userRepo.js';
import { GiveawayService } from './giveawayService.js';

const USDT = 1_000_000;
const HOUR = 3_600_000;

function setup(n = 5) {
  const db = openDatabase(':memory:');
  const clock = { now: Date.UTC(2026, 9, 10, 12) };
  const users = new UserRepo(db);
  const people = Array.from({ length: n }, (_, i) => users.upsertFromTelegram({ id: i + 1, first_name: `U${i + 1}`, last_name: 'Петров' }));
  const ledger = new Ledger(db, () => clock.now);
  const sent: string[] = [];
  const notifications = new NotificationService(db, { send: async (_id, text) => void sent.push(text) }, () => {}, () => clock.now);
  const svc = new GiveawayService(db, ledger, users, notifications, undefined, () => clock.now);
  return { db, clock, users, people, ledger, svc, sent };
}

describe('GiveawayService', () => {
  it('joins once for free and splits the prize between random winners', () => {
    const t = setup(5);
    const g = t.svc.create({ title: 'Осенний', prizeUsdt: 30, winners: 3, endsAt: t.clock.now + HOUR });
    for (const p of t.people) t.svc.join(p, g.id);
    t.svc.join(t.people[0], g.id);
    const cur = t.svc.current(t.people[0].id)!;
    expect(cur.participants).toBe(5);
    expect(cur.joined).toBe(true);
    // Joining costs nothing.
    expect(t.ledger.balances(t.people[0].id).availableMicro).toBe(0);

    expect(() => t.svc.draw(g.id)).toThrow(/ещё идёт/);
    t.clock.now += HOUR;
    expect(() => t.svc.join(t.people[1], g.id)).toThrow(/закончился/);
    const res = t.svc.draw(g.id);
    expect(res.status).toBe('drawn');
    expect(res.results).toHaveLength(3);
    const total = t.people.reduce((s, p) => s + t.ledger.balances(p.id).availableMicro, 0);
    expect(total).toBe(30 * USDT);
    expect(new Set(res.results.map((r) => r.userId)).size).toBe(3);
    expect(t.sent.filter((s) => s.includes('Вы выиграли'))).toHaveLength(3);
    expect(() => t.svc.draw(g.id)).toThrow(/уже проведён/);

    const shown = t.svc.current(res.results[0].userId)!;
    expect(shown.results.some((r) => r.you)).toBe(true);
    expect(shown.results[0].name).toMatch(/^U\d П\.$/);
  });

  it('caps winners at the number of participants and keeps one active giveaway', () => {
    const t = setup(2);
    const g = t.svc.create({ title: 'A', prizeUsdt: 10, winners: 5, endsAt: t.clock.now + HOUR });
    expect(() => t.svc.create({ title: 'B', prizeUsdt: 10, winners: 1, endsAt: t.clock.now + HOUR })).toThrow(/Уже идёт/);
    for (const p of t.people) t.svc.join(p, g.id);
    t.clock.now += HOUR;
    const res = t.svc.draw(g.id);
    expect(res.results.map((r) => r.prizeMicro)).toEqual([5 * USDT, 5 * USDT]);
  });

  it('leaves blocked users out of the draw', () => {
    const t = setup(2);
    const g = t.svc.create({ title: 'A', prizeUsdt: 10, winners: 2, endsAt: t.clock.now + HOUR });
    for (const p of t.people) t.svc.join(p, g.id);
    t.db.prepare('UPDATE users SET blocked = 1 WHERE id = ?').run(t.people[1].id);
    t.clock.now += HOUR;
    expect(t.svc.draw(g.id).results.map((r) => r.userId)).toEqual([t.people[0].id]);
  });
});
