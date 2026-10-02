export const RAPIRA_RATES_URL = 'https://api.rapira.net/open/market/rates';

export interface RapiraTicker {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Change since `open` as a fraction (0.01 = 1%). */
  chg: number;
  lastDayClose: number;
  askPrice: number;
  bidPrice: number;
}

export async function fetchRapiraTickers(fetchImpl: typeof fetch = fetch): Promise<RapiraTicker[]> {
  const res = await fetchImpl(RAPIRA_RATES_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Rapira responded ${res.status}`);
  const body = (await res.json()) as { data?: RapiraTicker[] };
  if (!Array.isArray(body.data)) throw new Error('Rapira response has no data array');
  return body.data;
}
