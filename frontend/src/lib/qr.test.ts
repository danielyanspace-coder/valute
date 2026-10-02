import { describe, expect, it } from 'vitest';
import { parseQr } from './qr';

describe('parseQr', () => {
  it('parses dynamic SBP link with amount in kopecks', () => {
    const r = parseQr('https://qr.nspk.ru/AS1000670LSS7DN18SJQDNP4B05KLJL2?type=02&bank=100000000111&sum=150050&cur=RUB&crc=C08B');
    expect(r).toMatchObject({ kind: 'sbp', id: 'AS1000670LSS7DN18SJQDNP4B05KLJL2', qrType: 'dynamic', amountRub: 1500.5, bankId: '100000000111' });
  });

  it('parses static SBP link without amount', () => {
    expect(parseQr('https://qr.nspk.ru/BS1A?type=01&bank=100000000004')).toMatchObject({ kind: 'sbp', qrType: 'static', amountRub: undefined });
  });

  it('parses GOST invoice', () => {
    const r = parseQr('ST00012|Name=ООО Ромашка|PersonalAcc=40702810000000000000|Sum=250000|Purpose=Оплата по счёту 15');
    expect(r).toMatchObject({ kind: 'invoice', payee: 'ООО Ромашка', amountRub: 2500, purpose: 'Оплата по счёту 15' });
  });

  it('detects crypto addresses and URIs', () => {
    expect(parseQr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toMatchObject({ kind: 'crypto', network: 'TRC20' });
    expect(parseQr('0xdAC17F958D2ee523a2206206994597C13D831ec7')).toMatchObject({ kind: 'crypto', network: 'EVM' });
    expect(parseQr('tron:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t?amount=10')).toMatchObject({ network: 'TRC20', amount: 10 });
    expect(
      parseQr('ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@1/transfer?address=0x1111111111111111111111111111111111111111&uint256=1e6'),
    ).toMatchObject({ network: 'EVM', address: '0x1111111111111111111111111111111111111111' });
    expect(parseQr('ton://transfer/UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG')).toMatchObject({ network: 'TON' });
  });

  it('falls back to url / text', () => {
    expect(parseQr('https://example.com')).toMatchObject({ kind: 'url' });
    expect(parseQr('hello')).toMatchObject({ kind: 'text' });
  });
});
