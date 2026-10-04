import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { UserRepo } from '../users/userRepo.js';
import { DepositAddressService } from './depositAddressService.js';
import { TRON_ACCOUNT_PATH } from './tronHd.js';

const xpubOf = (m: string) => HDKey.fromMasterSeed(mnemonicToSeedSync(m)).derive(TRON_ACCOUNT_PATH).publicExtendedKey;
const XPUB = xpubOf('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const OTHER = xpubOf('legal winner thank year wave sausage worth useful legal winner thank yellow');

function setup() {
  const db = openDatabase(':memory:');
  const users = new UserRepo(db);
  const a = users.upsertFromTelegram({ id: 1, first_name: 'A' });
  const b = users.upsertFromTelegram({ id: 2, first_name: 'B' });
  return { db, users, a, b };
}

describe('DepositAddressService', () => {
  it('issues one stable address per user with increasing indexes', () => {
    const { db, users, a, b } = setup();
    const s = new DepositAddressService(db, XPUB);
    const addrA = s.forUser(a.id);
    expect(addrA).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
    expect(s.forUser(a.id)).toBe(addrA);
    const addrB = s.forUser(b.id);
    expect(addrB).not.toBe(addrA);
    expect(s.ownerOf(addrB)).toEqual({ userId: b.id, index: 1 });
    expect(users.depositAddresses(a.id)).toHaveLength(1);
  });

  it('refuses to start with another xpub once addresses exist', () => {
    const { db, a } = setup();
    new DepositAddressService(db, OTHER); // nothing issued yet: swapping is fine
    new DepositAddressService(db, XPUB).forUser(a.id);
    expect(() => new DepositAddressService(db, OTHER)).toThrow(/differs/);
    expect(() => new DepositAddressService(db, XPUB)).not.toThrow();
  });
});
