import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// SQLite (built into Node) is enough for one server: every write goes through
// this process, and node:sqlite is synchronous, so a function without `await`
// inside runs atomically. The schema is plain SQL and ports to PostgreSQL as is.

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT,
    photo_url TEXT,
    language_code TEXT,
    blocked INTEGER NOT NULL DEFAULT 0,
    missed_confirmations INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  -- Every balance change is a row; balances are sums. bucket: available | frozen
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    bucket TEXT NOT NULL CHECK (bucket IN ('available', 'frozen')),
    amount_micro INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    comment TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ledger_user ON ledger_entries(user_id);

  CREATE TABLE deposit_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    derivation_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (chain, address),
    UNIQUE (user_id, chain)
  );

  CREATE TABLE withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('sbp', 'card')),
    phone TEXT,
    bank_id TEXT,
    bank_name TEXT,
    card_number TEXT,
    card_brand TEXT,
    amount_rub INTEGER NOT NULL,
    amount_micro INTEGER NOT NULL,
    rate REAL NOT NULL,
    exchange_rate REAL,
    balance_before_micro INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    confirm_deadline INTEGER,
    finished_at INTEGER,
    confirmed_by TEXT,
    reject_reason TEXT,
    contact_requested_at INTEGER,
    client_ip TEXT,
    user_agent TEXT,
    platform TEXT,
    UNIQUE (user_id, request_id)
  );
  CREATE INDEX withdrawals_status ON withdrawals(status, created_at);
  CREATE INDEX withdrawals_user ON withdrawals(user_id, created_at);
  CREATE INDEX withdrawals_phone ON withdrawals(phone);
  CREATE INDEX withdrawals_card ON withdrawals(card_number);

  -- Full audit trail of a withdrawal: who did what and when.
  CREATE TABLE withdrawal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    withdrawal_id INTEGER NOT NULL REFERENCES withdrawals(id),
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX withdrawal_events_w ON withdrawal_events(withdrawal_id);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    withdrawal_id INTEGER,
    created_at INTEGER NOT NULL,
    seen_at INTEGER
  );
  CREATE INDEX notifications_unseen ON notifications(user_id, seen_at);
  `,
  `
  CREATE INDEX users_username ON users(username COLLATE NOCASE);

  -- A check reserves USDT (frozen bucket) until someone activates it or the creator cancels it.
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    amount_micro INTEGER NOT NULL,
    comment TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'claimed', 'cancelled')),
    source TEXT NOT NULL CHECK (source IN ('app', 'inline')),
    request_id TEXT,
    inline_message_id TEXT,
    created_at INTEGER NOT NULL,
    claimed_by INTEGER REFERENCES users(id),
    claimed_at INTEGER,
    cancelled_at INTEGER,
    UNIQUE (creator_id, request_id)
  );
  CREATE INDEX checks_creator ON checks(creator_id, created_at);

  -- What the user saw in inline mode before sending it; becomes a check once the message is sent.
  CREATE TABLE check_offers (
    code TEXT PRIMARY KEY,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    amount_micro INTEGER NOT NULL,
    comment TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id),
    to_user_id INTEGER NOT NULL REFERENCES users(id),
    amount_micro INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'check')),
    check_id INTEGER REFERENCES checks(id),
    comment TEXT,
    request_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (from_user_id, request_id)
  );
  CREATE INDEX transfers_from ON transfers(from_user_id, created_at);
  CREATE INDEX transfers_to ON transfers(to_user_id, created_at);

  ALTER TABLE notifications ADD COLUMN transfer_id INTEGER;
  ALTER TABLE notifications ADD COLUMN check_id INTEGER;
  `,
];

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
