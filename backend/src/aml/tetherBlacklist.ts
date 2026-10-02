import { tronToHex } from './base58.js';
import type { AmlCheck, AmlSignal, Chain } from './types.js';

/**
 * Tether can freeze any address on its USDT contracts. A frozen sender is a
 * strong red flag, and funds received from it may themselves get frozen.
 * Checked with a free read-only eth_call; TRON nodes expose the same JSON-RPC.
 */
const CONTRACTS: Partial<Record<Chain, { usdt: string; selector: string }>> = {
  // getBlackListStatus(address)
  TRON: { usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', selector: '0x59bf1abe' },
  // isBlackListed(address)
  ETH: { usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', selector: '0xe47d6060' },
  // BSC USDT is Binance-Peg without a blacklist; TON jetton has no on-chain list to query.
};

export class TetherBlacklistCheck implements AmlCheck {
  readonly source = 'tether_blacklist';

  constructor(
    private readonly rpcUrls: Partial<Record<Chain, string>>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supports(chain: Chain): boolean {
    return !!CONTRACTS[chain] && !!this.rpcUrls[chain];
  }

  async check(chain: Chain, address: string): Promise<AmlSignal> {
    const c = CONTRACTS[chain]!;
    const toHex = (a: string) => (chain === 'TRON' ? tronToHex(a) : a.toLowerCase());
    const data = c.selector + toHex(address).slice(2).padStart(64, '0');
    const res = await this.fetchImpl(this.rpcUrls[chain]!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: toHex(c.usdt), data }, 'latest'],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RPC ${chain} responded ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error || !body.result) throw new Error(`RPC ${chain}: ${body.error?.message ?? 'empty result'}`);
    const hit = BigInt(body.result) !== 0n;
    return { source: this.source, hit, detail: hit ? 'Адрес заморожен Tether' : undefined };
  }
}
