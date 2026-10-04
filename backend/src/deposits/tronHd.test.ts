import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { describe, expect, it } from 'vitest';
import { TRON_ACCOUNT_PATH, TronXpub, isTronAddress, tronAddressFromPublicKey } from './tronHd.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const xpub = root.derive(TRON_ACCOUNT_PATH).publicExtendedKey;

describe('TronXpub', () => {
  it('matches the well-known vector for m/44\'/195\'/0\'/0/0', () => {
    expect(new TronXpub(xpub).address(0)).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });

  it('derives the same addresses as the full private path', () => {
    const w = new TronXpub(xpub);
    const priv = root.derive(`${TRON_ACCOUNT_PATH}/0/7`);
    expect(w.address(7)).toBe(tronAddressFromPublicKey(priv.publicKey!));
    expect(w.address(1)).not.toBe(w.address(0));
    expect(isTronAddress(w.address(1))).toBe(true);
  });

  it('refuses private keys and wrong depth', () => {
    expect(() => new TronXpub(root.derive(TRON_ACCOUNT_PATH).privateExtendedKey)).toThrow(/public/);
    expect(() => new TronXpub(root.publicExtendedKey)).toThrow(/depth/);
  });

  it('validates addresses', () => {
    expect(isTronAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH')).toBe(true);
    expect(isTronAddress('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdh')).toBe(false);
  });
});
