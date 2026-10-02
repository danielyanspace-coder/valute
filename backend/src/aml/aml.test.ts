import { describe, expect, it } from 'vitest';
import { AmlService, decide } from './amlService.js';
import { tronToHex } from './base58.js';
import { OfacSanctionsCheck } from './ofacList.js';
import { TetherBlacklistCheck } from './tetherBlacklist.js';
import type { AmlCheck } from './types.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const word = (n: number) => '0x' + n.toString(16).padStart(64, '0');

describe('tronToHex', () => {
  it('converts USDT contract address and validates checksum', () => {
    expect(tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(() => tronToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toThrow(/checksum/);
    expect(() => tronToHex('0xdead')).toThrow();
  });
});

describe('TetherBlacklistCheck', () => {
  it('builds eth_call to the TRON USDT contract and reads the flag', async () => {
    const calls: any[] = [];
    const check = new TetherBlacklistCheck({ TRON: 'http://tron' }, (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return json({ result: word(1) });
    }) as typeof fetch);
    const r = await check.check('TRON', 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi');
    expect(r.hit).toBe(true);
    expect(calls[0].params[0].to).toBe('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(calls[0].params[0].data).toMatch(/^0x59bf1abe0{24}[0-9a-f]{40}$/);
  });

  it('supports only chains with a contract and an RPC url', () => {
    const check = new TetherBlacklistCheck({ ETH: 'http://eth' });
    expect(check.supports('ETH')).toBe(true);
    expect(check.supports('TRON')).toBe(false);
    expect(check.supports('BSC')).toBe(false);
  });
});

describe('OfacSanctionsCheck', () => {
  const lists: Record<string, string> = {
    TRX: 'TA3rH2A7iHnm6pKH8gr9cK1EZnShnmZdFg\n',
    ETH: '0x8589427373D6D84E98730D7795D8f6f8731FDA16\n',
  };
  const fetchLists = (async (url: string) =>
    new Response(lists[/addresses_(\w+)\.txt/.exec(url)![1]])) as unknown as typeof fetch;

  it('matches TRON exactly and EVM case-insensitively, incl. BSC', async () => {
    const check = new OfacSanctionsCheck(fetchLists);
    expect((await check.check('TRON', 'TA3rH2A7iHnm6pKH8gr9cK1EZnShnmZdFg')).hit).toBe(true);
    expect((await check.check('BSC', '0x8589427373d6d84e98730d7795d8f6f8731fda16')).hit).toBe(true);
    expect((await check.check('ETH', '0x0000000000000000000000000000000000000002')).hit).toBe(false);
  });

  it('keeps the previous list when a refresh fails', async () => {
    let now = 0;
    let fail = false;
    const f = (async (url: string) => (fail ? new Response('', { status: 500 }) : (fetchLists as any)(url))) as typeof fetch;
    const check = new OfacSanctionsCheck(f, () => now);
    await check.check('TRON', 'x');
    fail = true;
    now = 13 * 60 * 60 * 1000;
    expect((await check.check('TRON', 'TA3rH2A7iHnm6pKH8gr9cK1EZnShnmZdFg')).hit).toBe(true);
  });
});

describe('AmlService', () => {
  const fake = (source: string, result: 'hit' | 'clean' | 'error', chains = ['TRON']): AmlCheck => ({
    source,
    supports: (c) => chains.includes(c),
    check: async () => {
      if (result === 'error') throw new Error('down');
      return { source, hit: result === 'hit' };
    },
  });

  it('rejects on any hit, reviews on errors or no coverage, clears otherwise', async () => {
    expect((await new AmlService([fake('a', 'clean'), fake('b', 'hit')]).screen('TRON', 'T')).decision).toBe('reject');
    expect((await new AmlService([fake('a', 'clean'), fake('b', 'error')]).screen('TRON', 'T')).decision).toBe('review');
    expect((await new AmlService([fake('a', 'clean')]).screen('TON', 'EQ')).decision).toBe('review');
    expect((await new AmlService([fake('a', 'clean'), fake('b', 'clean')]).screen('TRON', 'T')).decision).toBe('clear');
  });

  it('decide: a hit outranks an error', () => {
    expect(decide([{ source: 'a', hit: true }, { source: 'b', hit: false, error: 'x' }])).toBe('reject');
  });
});
