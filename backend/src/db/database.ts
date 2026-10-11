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
  `
  -- Service orders (fines, parking, Steam): paid in USDT, fulfilled by the operator by hand ("МК").
  CREATE TABLE service_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fine', 'parking', 'steam')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'clarify', 'paid', 'rejected')),
    amount_rub INTEGER NOT NULL,
    amount_micro INTEGER NOT NULL,
    rate REAL NOT NULL,
    exchange_rate REAL NOT NULL,
    discount_percent REAL NOT NULL,
    uin TEXT,
    fine_json TEXT,
    amount_source TEXT,
    phone TEXT,
    steam_login TEXT,
    clarify_message TEXT,
    reject_reason TEXT,
    balance_before_micro INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    client_ip TEXT,
    platform TEXT,
    UNIQUE (user_id, request_id)
  );
  CREATE INDEX service_orders_status ON service_orders(status, created_at);
  CREATE INDEX service_orders_user ON service_orders(user_id, created_at);

  CREATE TABLE service_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES service_orders(id),
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX service_order_events_o ON service_order_events(order_id);

  ALTER TABLE notifications ADD COLUMN order_id INTEGER;
  `,
  // 4: key/value settings that must survive restarts (e.g. which xpub issued the addresses).
  `
  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 5: incoming USDT TRC-20 deposits and the watcher's per-address schedule.
  `
  CREATE TABLE deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    from_address TEXT,
    amount_micro INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'credited', 'below_min', 'held', 'rejected', 'failed')),
    aml_decision TEXT,
    aml_detail TEXT,
    block_number INTEGER,
    block_time INTEGER,
    seen_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    finished_at INTEGER,
    credited_by TEXT,
    admin_note TEXT,
    UNIQUE (chain, tx_id, address)
  );
  CREATE INDEX deposits_user ON deposits(user_id, seen_at);
  CREATE INDEX deposits_status ON deposits(status, seen_at);

  ALTER TABLE deposit_addresses ADD COLUMN last_checked_at INTEGER;
  ALTER TABLE deposit_addresses ADD COLUMN last_viewed_at INTEGER;
  ALTER TABLE deposit_addresses ADD COLUMN cursor_ts INTEGER;
  ALTER TABLE notifications ADD COLUMN deposit_id INTEGER;
  `,
  // 6: manual withdrawal deals through an external platform, journal, shadow holds, broadcasts.
  `
  ALTER TABLE withdrawals ADD COLUMN taken_at INTEGER;
  ALTER TABLE withdrawals ADD COLUMN entered_at INTEGER;
  ALTER TABLE withdrawals ADD COLUMN requisite_off_at INTEGER;
  ALTER TABLE withdrawals ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE withdrawals ADD COLUMN bot_message_id INTEGER;
  ALTER TABLE withdrawals ADD COLUMN inactive_since INTEGER;
  ALTER TABLE withdrawals ADD COLUMN user_decision TEXT;
  ALTER TABLE withdrawals ADD COLUMN user_decided_at INTEGER;
  ALTER TABLE withdrawals ADD COLUMN reported_rub INTEGER;
  ALTER TABLE withdrawals ADD COLUMN user_confirmed_at INTEGER;
  ALTER TABLE withdrawals ADD COLUMN final_rub INTEGER;
  ALTER TABLE withdrawals ADD COLUMN debited_micro INTEGER;
  ALTER TABLE withdrawals ADD COLUMN refunded_micro INTEGER;
  ALTER TABLE withdrawals ADD COLUMN resolution TEXT;
  ALTER TABLE withdrawals ADD COLUMN external_id TEXT;
  CREATE INDEX withdrawals_external ON withdrawals(external_id);

  -- Old lifecycle → new one. Old "sent" deals have had their window: they wait for the operator.
  UPDATE withdrawals SET status = 'new' WHERE status = 'pending';
  UPDATE withdrawals SET status = 'inactive', entered_at = sent_at, reminders_sent = 5, inactive_since = COALESCE(confirm_deadline, sent_at)
    WHERE status = 'sent';
  UPDATE withdrawals SET status = 'not_received', entered_at = sent_at, reminders_sent = 5, user_decision = 'not_received' WHERE status = 'disputed';
  UPDATE withdrawals SET debited_micro = amount_micro, final_rub = amount_rub,
    resolution = CASE WHEN confirmed_by = 'user' THEN 'closed' ELSE 'confirmed_admin' END WHERE status = 'completed';
  UPDATE withdrawals SET status = 'cancelled', refunded_micro = amount_micro, resolution = 'cancelled' WHERE status = 'rejected';

  ALTER TABLE users ADD COLUMN support_lock_at INTEGER;
  ALTER TABLE users ADD COLUMN bot_blocked_at INTEGER;
  UPDATE users SET support_lock_at = (
    SELECT MAX(contact_requested_at) FROM withdrawals w
    WHERE w.user_id = users.id AND w.contact_requested_at IS NOT NULL AND w.status NOT IN ('completed', 'cancelled'))
  WHERE support_lock_at IS NULL;

  UPDATE notifications SET seen_at = created_at
    WHERE seen_at IS NULL AND type IN ('confirm_receipt', 'contact_support', 'withdrawal_completed', 'withdrawal_rejected');
  ALTER TABLE notifications ADD COLUMN obligation_id INTEGER;
  ALTER TABLE notifications ADD COLUMN amount_micro INTEGER;

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    user_id INTEGER,
    withdrawal_id INTEGER,
    obligation_id INTEGER,
    amount_micro INTEGER,
    amount_rub INTEGER,
    data TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);
  CREATE INDEX audit_user ON audit_log(user_id, at);
  CREATE INDEX audit_deal ON audit_log(withdrawal_id, at);
  CREATE INDEX audit_type ON audit_log(type, at);
  INSERT INTO audit_log (at, actor, type, user_id, withdrawal_id, data)
    SELECT e.at, e.actor, CASE e.type
        WHEN 'created' THEN 'deal_created' WHEN 'marked_sent' THEN 'deal_entered' WHEN 'confirmed' THEN 'admin_confirmed'
        WHEN 'disputed' THEN 'user_not_received' WHEN 'rejected' THEN 'deal_cancelled' WHEN 'note' THEN 'note'
        ELSE 'note' END,
      w.user_id, e.withdrawal_id, e.data
    FROM withdrawal_events e JOIN withdrawals w ON w.id = e.withdrawal_id ORDER BY e.id;

  CREATE TABLE deal_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    withdrawal_id INTEGER NOT NULL REFERENCES withdrawals(id),
    n INTEGER NOT NULL,
    at INTEGER NOT NULL,
    delivered INTEGER NOT NULL,
    error TEXT,
    UNIQUE (withdrawal_id, n)
  );

  CREATE TABLE obligations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount_micro INTEGER NOT NULL CHECK (amount_micro > 0),
    repaid_micro INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('active', 'repaid', 'written_off')),
    public_reason TEXT NOT NULL,
    comment TEXT,
    withdrawal_id INTEGER REFERENCES withdrawals(id),
    created_at INTEGER NOT NULL,
    repaid_at INTEGER,
    written_off_at INTEGER,
    write_off_comment TEXT
  );
  CREATE INDEX obligations_user ON obligations(user_id, status);

  CREATE TABLE broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    photo BLOB,
    photo_file_id TEXT,
    button_text TEXT,
    button_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('sending', 'done', 'failed')),
    total INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER
  );
  CREATE TABLE broadcast_deliveries (
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'blocked')),
    error TEXT,
    at INTEGER,
    PRIMARY KEY (broadcast_id, user_id)
  );
  `,
  // 7: deposits through a pool of public addresses lent to one user per request.
  `
  CREATE TABLE deposit_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    -- 1 = the operator's own wallet: never lent, transfers FROM it are not deposits
    own INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    cursor_ts INTEGER
  );
  CREATE TABLE deposit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    address TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'paid', 'cancelled', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX deposit_requests_address ON deposit_requests(address, created_at);
  CREATE INDEX deposit_requests_user ON deposit_requests(user_id, created_at);
  CREATE UNIQUE INDEX deposit_requests_one_active ON deposit_requests(user_id) WHERE status = 'active';

  CREATE TABLE deposits_v7 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    tx_id TEXT NOT NULL,
    from_address TEXT,
    amount_micro INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'credited', 'below_min', 'held', 'rejected', 'failed')),
    aml_decision TEXT,
    aml_detail TEXT,
    block_number INTEGER,
    block_time INTEGER,
    seen_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    finished_at INTEGER,
    credited_by TEXT,
    admin_note TEXT,
    request_id INTEGER REFERENCES deposit_requests(id),
    issued_to INTEGER REFERENCES users(id),
    late INTEGER NOT NULL DEFAULT 0,
    review TEXT,
    UNIQUE (chain, tx_id, address)
  );
  INSERT INTO deposits_v7 (id, user_id, chain, address, tx_id, from_address, amount_micro, status, aml_decision, aml_detail,
    block_number, block_time, seen_at, confirmed_at, finished_at, credited_by, admin_note, issued_to, review)
  SELECT id, user_id, chain, address, tx_id, from_address, amount_micro, status, aml_decision, aml_detail,
    block_number, block_time, seen_at, confirmed_at, finished_at, credited_by, admin_note, user_id,
    CASE WHEN status = 'held' THEN 'aml' END
  FROM deposits;
  DROP TABLE deposits;
  ALTER TABLE deposits_v7 RENAME TO deposits;
  CREATE INDEX deposits_user ON deposits(user_id, seen_at);
  CREATE INDEX deposits_status ON deposits(status, seen_at);
  CREATE INDEX deposits_sender ON deposits(from_address);
  `,
  // 8: USDT TRC-20 withdrawals, sent by hand by the operator.
  `
  CREATE TABLE usdt_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    address TEXT NOT NULL,
    amount_micro INTEGER NOT NULL,
    fee_micro INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('new', 'sent', 'rejected')),
    aml_decision TEXT,
    aml_detail TEXT,
    tx_id TEXT UNIQUE,
    reject_reason TEXT,
    admin_note TEXT,
    balance_before_micro INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    client_ip TEXT,
    UNIQUE (user_id, request_id)
  );
  CREATE INDEX usdt_payouts_status ON usdt_payouts(status, created_at);
  CREATE INDEX usdt_payouts_user ON usdt_payouts(user_id, created_at);
  ALTER TABLE notifications ADD COLUMN usdt_payout_id INTEGER;
  `,
  // 9: "money has not arrived yet" under reminders 1-4: marks the user as responsive.
  `
  ALTER TABLE withdrawals ADD COLUMN user_active_at INTEGER;
  ALTER TABLE deal_reminders ADD COLUMN reacted_at INTEGER;
  `,
  // 10: IX Black status (priority queue, monthly cashback) and free giveaways.
  `
  CREATE TABLE premium_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    request_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    price_micro INTEGER NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, request_id)
  );
  CREATE INDEX premium_user ON premium_subscriptions(user_id, ends_at);
  CREATE TABLE premium_cashback (
    user_id INTEGER NOT NULL REFERENCES users(id),
    month TEXT NOT NULL,
    turnover_micro INTEGER NOT NULL,
    amount_micro INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, month)
  );
  CREATE TABLE premium_reminders (
    subscription_id INTEGER NOT NULL REFERENCES premium_subscriptions(id),
    kind TEXT NOT NULL,
    PRIMARY KEY (subscription_id, kind)
  );
  ALTER TABLE withdrawals ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE usdt_payouts ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE service_orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE giveaways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    prize_micro INTEGER NOT NULL,
    winners INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'drawn', 'cancelled')),
    created_at INTEGER NOT NULL,
    drawn_at INTEGER
  );
  CREATE TABLE giveaway_entries (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
  CREATE TABLE giveaway_winners (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    prize_micro INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  );
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
