import { tronAddressFromHex, tronAddressToHex } from './tronHd.js';

/** Tether USD on TRON mainnet. Anything else called "USDT" is a fake token. */
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface IncomingTransfer {
  txId: string;
  from: string;
  valueMicro: number;
  blockTimestamp: number;
}

/** What a solidified (irreversible) block says about a transaction. */
export type TxVerdict =
  | { state: 'unconfirmed' }
  | { state: 'failed' }
  | { state: 'confirmed'; valueMicro: number; from: string; blockNumber: number; blockTimestamp: number };

/** What a wallet holds right now: real Tether USDT only, plus TRX that pays network fees. */
export interface WalletBalance {
  usdtMicro: number;
  trxSun: number;
}

export interface TronChain {
  /** USDT transfers to the address since a moment, newest first. Discovery only: not proof. */
  incomingUsdt(address: string, sinceMs: number): Promise<IncomingTransfer[]>;
  /** Proof: USDT the tx moved to the address, read from the solidified chain. */
  verifyUsdtTo(txId: string, address: string): Promise<TxVerdict>;
  /** Current balance. An address that never received anything is not on chain yet: zeros. */
  balance(address: string): Promise<WalletBalance>;
}

const MAX_PAGES = 5;
const MAX_MICRO = 1_000_000_000 * 1_000_000; // 1e9 USDT: anything above is garbage

function toMicro(value: string | bigint): number {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  if (v <= 0n || v > BigInt(MAX_MICRO)) return 0;
  return Number(v);
}

/**
 * TronGrid (api.trongrid.io): the indexed API finds candidate transfers, the
 * solidity node confirms each one before any money is credited.
 * Without an API key TronGrid throttles hard; get a free key at trongrid.io.
 */
export class TronGridClient implements TronChain {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(path.startsWith('http') ? path : `${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`TronGrid ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async incomingUsdt(address: string, sinceMs: number): Promise<IncomingTransfer[]> {
    const out: IncomingTransfer[] = [];
    const qs = new URLSearchParams({
      only_to: 'true',
      contract_address: USDT_TRC20,
      limit: '50',
      min_timestamp: String(Math.max(0, Math.floor(sinceMs))),
    });
    let url: string | null = `/v1/accounts/${address}/transactions/trc20?${qs}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const json: any = await this.request(url);
      if (json.success === false) throw new Error(`TronGrid: ${json.error ?? 'request failed'}`);
      for (const t of json.data ?? []) {
        if (t.type !== 'Transfer' || t.to !== address || t.token_info?.address !== USDT_TRC20) continue;
        const valueMicro = toMicro(String(t.value ?? '0'));
        if (!valueMicro || typeof t.transaction_id !== 'string') continue;
        out.push({ txId: t.transaction_id, from: String(t.from), valueMicro, blockTimestamp: Number(t.block_timestamp) || Date.now() });
      }
      url = json.meta?.links?.next ?? null;
    }
    return out;
  }

  async verifyUsdtTo(txId: string, address: string): Promise<TxVerdict> {
    const info: any = await this.request('/walletsolidity/gettransactioninfobyid', { value: txId });
    return verdictFromTxInfo(info, address);
  }

  /**
   * USDT straight from the Tether contract (balanceOf): the account index knows nothing about
   * an address that has never held TRX, yet such an address can hold USDT. TRX from the index.
   */
  async balance(address: string): Promise<WalletBalance> {
    // One after the other: the key's 15 requests a second are shared with the deposit watcher.
    const call: any = await this.request('/wallet/triggerconstantcontract', {
      owner_address: USDT_TRC20,
      contract_address: USDT_TRC20,
      function_selector: 'balanceOf(address)',
      parameter: tronAddressToHex(address).slice(2).padStart(64, '0'),
      visible: true,
    });
    const account: any = await this.request(`/v1/accounts/${address}`);
    return { usdtMicro: usdtFromBalanceOf(call), trxSun: trxFromAccount(account?.data?.[0]) };
  }
}

/** Pure part of balance(): the uint256 balanceOf returned. Throws rather than report a wrong zero. */
export function usdtFromBalanceOf(call: any): number {
  const hex = call?.constant_result?.[0];
  if (call?.result?.result !== true || typeof hex !== 'string' || !/^[0-9a-f]{1,64}$/i.test(hex)) {
    throw new Error(`balanceOf failed: ${JSON.stringify(call?.result ?? call).slice(0, 150)}`);
  }
  return Number(BigInt(`0x${hex}`));
}

/** TRX in sun; an address that never held TRX is not in the index at all: zero. */
export function trxFromAccount(account: any): number {
  const trx = Number(account?.balance ?? 0);
  return Number.isFinite(trx) && trx > 0 ? trx : 0;
}

/** Pure part of verification, exported for tests. */
export function verdictFromTxInfo(info: any, address: string): TxVerdict {
  if (!info || !info.id) return { state: 'unconfirmed' }; // not in a solidified block yet
  if (info.receipt?.result !== 'SUCCESS') return { state: 'failed' };
  const usdtHex = tronAddressToHex(USDT_TRC20).slice(2);
  const toHex = tronAddressToHex(address).slice(2);
  let total = 0n;
  let from = '';
  for (const log of info.log ?? []) {
    const topics: string[] = log.topics ?? [];
    if (String(log.address).toLowerCase() !== usdtHex || topics[0] !== TRANSFER_TOPIC || topics.length < 3) continue;
    if (topics[2].slice(-40).toLowerCase() !== toHex) continue;
    total += BigInt(`0x${log.data || '0'}`);
    from ||= tronAddressFromHex(topics[1].slice(-40));
  }
  const valueMicro = toMicro(total);
  if (!valueMicro) return { state: 'failed' };
  return { state: 'confirmed', valueMicro, from, blockNumber: Number(info.blockNumber), blockTimestamp: Number(info.blockTimeStamp) };
}
