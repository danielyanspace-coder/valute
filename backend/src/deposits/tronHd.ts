import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';

/**
 * TRON HD addresses (BIP-44, coin type 195), derived from the account-level
 * extended PUBLIC key m/44'/195'/0'. The server never sees the seed: with an xpub
 * it can only compute addresses, not spend from them.
 *
 * Deposit address #i = m/44'/195'/0'/0/i, the same path TronLink, Trust and Ledger use,
 * so any of them can restore the funds from the mnemonic if needed.
 */
export const TRON_ACCOUNT_PATH = "m/44'/195'/0'";

const base58check = createBase58check(sha256);

/** TRON address (T...) from a secp256k1 public key, compressed or not. */
export function tronAddressFromPublicKey(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(hash.subarray(12), 1);
  return base58check.encode(payload);
}

export function isTronAddress(value: string): boolean {
  try {
    const bytes = base58check.decode(value);
    return bytes.length === 21 && bytes[0] === 0x41;
  } catch {
    return false;
  }
}

export class TronXpub {
  private readonly external: HDKey;

  constructor(readonly xpub: string) {
    const account = HDKey.fromExtendedKey(xpub);
    if (account.privateKey) throw new Error('TRON_XPUB must be a public key (xpub...), never the private one');
    if (account.depth !== 3) throw new Error(`TRON_XPUB must be the account key ${TRON_ACCOUNT_PATH} (depth 3), got depth ${account.depth}`);
    this.external = account.deriveChild(0);
  }

  address(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error(`bad derivation index ${index}`);
    return tronAddressFromPublicKey(this.external.deriveChild(index).publicKey!);
  }
}

/** T... → 41-prefixed hex, as TRON nodes return addresses in raw responses. */
export function tronAddressToHex(address: string): string {
  return Buffer.from(base58check.decode(address)).toString('hex');
}

/** 41-prefixed (or bare 20-byte) hex → T... */
export function tronAddressFromHex(hex: string): string {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  const body = clean.length === 40 ? `41${clean}` : clean;
  return base58check.encode(Uint8Array.from(Buffer.from(body, 'hex')));
}
