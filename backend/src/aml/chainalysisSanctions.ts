import type { AmlCheck, AmlSignal, Chain } from './types.js';

/**
 * Chainalysis free sanctions screening API (needs a free key from
 * https://go.chainalysis.com/crypto-sanctions-screening.html). Optional — enabled
 * only when CHAINALYSIS_SANCTIONS_API_KEY is set.
 */
export class ChainalysisSanctionsCheck implements AmlCheck {
  readonly source = 'chainalysis_sanctions';

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  supports(_chain: Chain): boolean {
    return true;
  }

  async check(_chain: Chain, address: string): Promise<AmlSignal> {
    const res = await this.fetchImpl(
      `https://public.chainalysis.com/api/v1/address/${encodeURIComponent(address)}`,
      { headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`Chainalysis responded ${res.status}`);
    const body = (await res.json()) as { identifications?: { name?: string; category?: string }[] };
    const ids = body.identifications ?? [];
    return {
      source: this.source,
      hit: ids.length > 0,
      detail: ids.length ? ids.map((i) => i.name ?? i.category).join('; ') : undefined,
    };
  }
}
