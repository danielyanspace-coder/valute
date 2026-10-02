import type { AmlCheck, AmlSignal, Chain } from './types.js';

/**
 * OFAC SDN crypto addresses, extracted nightly from the US Treasury list:
 * https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses
 * EVM addresses (ETH list) apply to BSC too — same key, same owner.
 */
const LIST_URL = (code: string) =>
  `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_${code}.txt`;

const LISTS: Partial<Record<Chain, string>> = { TRON: 'TRX', ETH: 'ETH', BSC: 'ETH' };
const REFRESH_MS = 12 * 60 * 60 * 1000;

export class OfacSanctionsCheck implements AmlCheck {
  readonly source = 'ofac_sdn';
  private lists = new Map<string, Set<string>>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  supports(chain: Chain): boolean {
    return chain in LISTS;
  }

  async check(chain: Chain, address: string): Promise<AmlSignal> {
    await this.ensureFresh();
    const list = this.lists.get(LISTS[chain]!);
    if (!list) throw new Error('OFAC list not loaded');
    const hit = list.has(normalize(chain, address));
    return { source: this.source, hit, detail: hit ? 'Адрес в санкционном списке OFAC' : undefined };
  }

  /** Reloads when stale; keeps serving the previous copy if a refresh fails. */
  private async ensureFresh(): Promise<void> {
    if (this.now() - this.loadedAt < REFRESH_MS && this.lists.size) return;
    this.loading ??= this.load().finally(() => (this.loading = null));
    try {
      await this.loading;
    } catch (err) {
      if (!this.lists.size) throw err;
    }
  }

  private async load(): Promise<void> {
    const codes = [...new Set(Object.values(LISTS))];
    const fresh = new Map<string, Set<string>>();
    for (const code of codes) {
      const res = await this.fetchImpl(LIST_URL(code), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`OFAC list ${code}: ${res.status}`);
      const chain = code === 'TRX' ? 'TRON' : 'ETH';
      const lines = (await res.text()).split('\n').map((l) => l.trim()).filter(Boolean);
      fresh.set(code, new Set(lines.map((l) => normalize(chain, l))));
    }
    this.lists = fresh;
    this.loadedAt = this.now();
  }
}

function normalize(chain: Chain, address: string): string {
  // TRON base58 is case-sensitive; EVM hex is not.
  return chain === 'TRON' ? address : address.toLowerCase();
}
