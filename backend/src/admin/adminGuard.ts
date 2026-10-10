import type { Db } from '../db/database.js';

const KEY = 'admin_ips';
const FAIL_WINDOW = 15 * 60_000;
const FAIL_ALERT_AT = 10;
const MAX_KNOWN = 50;

/**
 * Tells the operator in Telegram when the admin panel is used from an IP it has not
 * seen before, or when someone keeps guessing the password. A stolen password is
 * noticed within seconds instead of after the money is gone.
 */
export class AdminGuard {
  private known: Set<string>;
  private fails = new Map<string, { since: number; count: number; alerted: boolean }>();

  constructor(
    private readonly db: Db,
    private readonly alert: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(KEY) as { value: string } | undefined;
    let list: string[] = [];
    try {
      list = row ? JSON.parse(row.value) : [];
    } catch {
      /* start over */
    }
    this.known = new Set(list);
  }

  access(ip: string, ok: boolean): void {
    if (ok) {
      this.fails.delete(ip);
      if (this.known.has(ip)) return;
      this.known.add(ip);
      const list = [...this.known].slice(-MAX_KNOWN);
      this.known = new Set(list);
      this.db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(list));
      this.alert(`Вход в админку Crypto IX с нового IP: ${ip}.\nЕсли это не вы, срочно смените ADMIN_TOKEN в /opt/cryptoix/.env и перезапустите службу.`);
      return;
    }
    const now = this.now();
    const f = this.fails.get(ip);
    const cur = f && now - f.since < FAIL_WINDOW ? f : { since: now, count: 0, alerted: false };
    cur.count++;
    if (cur.count >= FAIL_ALERT_AT && !cur.alerted) {
      cur.alerted = true;
      this.alert(`Подбор пароля к админке Crypto IX: ${cur.count} неверных попыток с IP ${ip} за 15 минут.`);
    }
    this.fails.set(ip, cur);
    if (this.fails.size > 10_000) this.fails.clear();
  }
}
