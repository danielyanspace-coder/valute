import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { transaction, type Db } from '../db/database.js';
import { TronXpub } from './tronHd.js';

const CHAIN = 'TRON';
const META_KEY = 'tron_xpub_fingerprint';

/**
 * Issues each user one permanent TRON deposit address: m/44'/195'/0'/0/<index>,
 * indexes go 0, 1, 2... in issue order and are never reused.
 *
 * The fingerprint of the xpub that issues addresses is stored in the DB. If the
 * server later starts with a different TRON_XPUB, it refuses to run: new users would get
 * addresses from another seed and old addresses would be "forgotten" by the sweeper.
 */
export class DepositAddressService {
  private readonly wallet: TronXpub;

  constructor(private readonly db: Db, xpub: string) {
    this.wallet = new TronXpub(xpub);
    const fingerprint = bytesToHex(sha256(utf8ToBytes(xpub))).slice(0, 16);
    const stored = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(META_KEY) as { value: string } | undefined;
    const issued = (db.prepare('SELECT COUNT(*) AS n FROM deposit_addresses WHERE chain = ?').get(CHAIN) as { n: number }).n;
    if (issued > 0 && stored?.value !== fingerprint) {
      throw new Error(stored
        ? 'TRON_XPUB differs from the one that issued existing deposit addresses. Restore the original xpub.'
        : 'Deposit addresses exist but the issuing xpub is unknown. Refusing to issue more.');
    }
    // No addresses yet: the xpub can still be swapped freely (e.g. testnet → mainnet).
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, fingerprint);
  }

  /** The user's address, issuing it on first request. */
  forUser(userId: number): string {
    return transaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT address FROM deposit_addresses WHERE user_id = ? AND chain = ?')
        .get(userId, CHAIN) as { address: string } | undefined;
      if (existing) return existing.address;
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(derivation_index) + 1, 0) AS next FROM deposit_addresses WHERE chain = ?')
        .get(CHAIN) as { next: number };
      const address = this.wallet.address(next);
      this.db
        .prepare('INSERT INTO deposit_addresses (user_id, chain, address, derivation_index, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, CHAIN, address, next, Date.now());
      return address;
    });
  }

  /** Who owns a TRON address (for the deposit watcher). */
  ownerOf(address: string): { userId: number; index: number } | null {
    const row = this.db
      .prepare('SELECT user_id AS userId, derivation_index AS "index" FROM deposit_addresses WHERE chain = ? AND address = ?')
      .get(CHAIN, address) as { userId: number; index: number } | undefined;
    return row ?? null;
  }
}
