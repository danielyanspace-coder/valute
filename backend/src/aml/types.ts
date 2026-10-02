export type Chain = 'TRON' | 'BSC' | 'ETH' | 'TON';

export interface AmlSignal {
  /** Which check produced this signal, e.g. "tether_blacklist". */
  source: string;
  /** true = address is flagged by this source. */
  hit: boolean;
  /** Set when the check could not run (network, misconfig). */
  error?: string;
  detail?: string;
}

/**
 * clear  — nothing found, credit automatically
 * review — a check failed to run; hold for an operator instead of crediting blindly
 * reject — address is sanctioned / frozen by Tether; freeze, never credit or sweep
 */
export type AmlDecision = 'clear' | 'review' | 'reject';

export interface AmlResult {
  chain: Chain;
  address: string;
  decision: AmlDecision;
  signals: AmlSignal[];
  checkedAt: number;
}

/** One screening source. Paid providers (BitOK, AMLBot) will implement this too. */
export interface AmlCheck {
  readonly source: string;
  supports(chain: Chain): boolean;
  check(chain: Chain, address: string): Promise<AmlSignal>;
}
