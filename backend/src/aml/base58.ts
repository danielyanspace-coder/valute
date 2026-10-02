import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function decodeBase58(input: string): Buffer {
  let n = 0n;
  for (const ch of input) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`Invalid base58 character "${ch}"`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const leadingZeros = input.match(/^1*/)![0].length;
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, 'hex')]);
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** TRON base58check address (T...) → 20-byte EVM-style hex (0x...), validating the checksum. */
export function tronToHex(address: string): string {
  const raw = decodeBase58(address);
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error('Not a TRON address');
  const payload = raw.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  if (!checksum.equals(raw.subarray(21))) throw new Error('Bad TRON address checksum');
  return '0x' + payload.subarray(1).toString('hex');
}
