import type { AmlCheck, AmlDecision, AmlResult, AmlSignal, Chain } from './types.js';

export class AmlService {
  constructor(
    private readonly checks: AmlCheck[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Screens the sender of a deposit (or the recipient of a withdrawal). */
  async screen(chain: Chain, address: string): Promise<AmlResult> {
    const applicable = this.checks.filter((c) => c.supports(chain));
    const signals = await Promise.all(
      applicable.map((c) =>
        c.check(chain, address).catch(
          (err: unknown): AmlSignal => ({ source: c.source, hit: false, error: String((err as Error)?.message ?? err) }),
        ),
      ),
    );
    return { chain, address, decision: decide(signals), signals, checkedAt: this.now() };
  }
}

export function decide(signals: AmlSignal[]): AmlDecision {
  if (signals.some((s) => s.hit)) return 'reject';
  // No checks at all (e.g. TON today) or any check failing → a human looks at it.
  if (signals.length === 0 || signals.some((s) => s.error)) return 'review';
  return 'clear';
}
