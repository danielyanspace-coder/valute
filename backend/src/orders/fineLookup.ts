import type { FineInfo } from '../../../shared/services.js';

/**
 * Where fine details come from. Real data lives in ГИС ГМП and is reachable through
 * aggregators (ШтрафовНет, shtraf.biz, A3...). Until one is connected, `NoFineLookup`
 * says "not available" and the user types the amount from the ruling; the operator checks it.
 */
export interface FineLookup {
  readonly available: boolean;
  /** null = no fine with this UIN (already paid or never existed). */
  lookup(uin: string): Promise<FineInfo | null>;
}

export class NoFineLookup implements FineLookup {
  readonly available = false;
  async lookup(): Promise<FineInfo | null> {
    throw new Error('Fine lookup provider is not configured');
  }
}
