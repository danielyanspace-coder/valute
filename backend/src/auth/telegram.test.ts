import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyInitData } from './telegram.js';

const BOT_TOKEN = '123456:TEST';

function sign(fields: Record<string, string>): string {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 42, first_name: 'Fox', username: 'darkfox_ix' });

describe('verifyInitData', () => {
  it('accepts correctly signed data', () => {
    const initData = sign({ auth_date: '1000', query_id: 'q', user });
    expect(verifyInitData(initData, BOT_TOKEN, 3600, 1500)?.user.id).toBe(42);
  });

  it('rejects tampered data', () => {
    const initData = sign({ auth_date: '1000', user }).replace('42', '43');
    expect(verifyInitData(initData, BOT_TOKEN, 3600, 1500)).toBeNull();
  });

  it('rejects wrong bot token and stale data', () => {
    const initData = sign({ auth_date: '1000', user });
    expect(verifyInitData(initData, '999:OTHER', 3600, 1500)).toBeNull();
    expect(verifyInitData(initData, BOT_TOKEN, 3600, 1000 + 3601)).toBeNull();
  });
});
