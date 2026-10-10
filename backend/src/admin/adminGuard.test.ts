import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { AdminGuard } from './adminGuard.js';

describe('AdminGuard', () => {
  it('alerts on a new IP once, remembers it across restarts', () => {
    const db = openDatabase(':memory:');
    const sent: string[] = [];
    const g = new AdminGuard(db, (t) => sent.push(t));
    g.access('1.1.1.1', true);
    g.access('1.1.1.1', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/нового IP: 1\.1\.1\.1/);
    new AdminGuard(db, (t) => sent.push(t)).access('1.1.1.1', true);
    expect(sent).toHaveLength(1);
  });

  it('alerts once on a run of wrong passwords, not on a typo', () => {
    let now = 0;
    const sent: string[] = [];
    const g = new AdminGuard(openDatabase(':memory:'), (t) => sent.push(t), () => now);
    g.access('6.6.6.6', false);
    expect(sent).toHaveLength(0);
    for (let i = 0; i < 20; i++) g.access('6.6.6.6', false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/10 неверных попыток с IP 6\.6\.6\.6/);
    now += 16 * 60_000;
    for (let i = 0; i < 9; i++) g.access('6.6.6.6', false);
    expect(sent).toHaveLength(1);
  });
});
