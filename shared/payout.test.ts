import { describe, expect, it } from 'vitest';
import {
  cardBrand, formatCard, formatRuPhone, maxPayoutRub, nextStatus, normalizeRuPhone,
  usdtMicroForRub, validateCard, validatePayoutRub, validateRuPhone,
} from './payout.js';
import { searchBanks } from './sbpBanks.js';

describe('phone', () => {
  it('normalises and validates Russian mobile numbers', () => {
    expect(normalizeRuPhone('8 (912) 345-67-89')).toBe('79123456789');
    expect(normalizeRuPhone('+7 912 345 67 89')).toBe('79123456789');
    expect(normalizeRuPhone('9123456789')).toBe('79123456789');
    expect(validateRuPhone('+79123456789')).toBeNull();
    expect(validateRuPhone('+7912345678')).toMatch(/полностью/);
    expect(validateRuPhone('+74951234567')).toMatch(/мобильный/);
    expect(formatRuPhone('79123456789')).toBe('+7 912 345-67-89');
    expect(formatRuPhone('8912')).toBe('+7 912');
  });
});

describe('card', () => {
  it('checks length, Luhn and brand', () => {
    expect(validateCard('2200 0000 0000 0004')).toBeNull();
    expect(validateCard('4111111111111111')).toBeNull();
    expect(validateCard('4111111111111112')).toMatch(/ошибка/);
    expect(validateCard('4111')).toMatch(/16/);
    expect(cardBrand('2202123412341234')).toBe('mir');
    expect(cardBrand('5555555555554444')).toBe('mastercard');
    expect(formatCard('2200000000000004')).toBe('2200 0000 0000 0004');
  });
});

describe('amount', () => {
  it('requires ≥500 and a multiple of 100', () => {
    expect(validatePayoutRub(500)).toBeNull();
    expect(validatePayoutRub(400)).toMatch(/500/);
    expect(validatePayoutRub(550)).toMatch(/кратна/);
    expect(validatePayoutRub(1000, 900)).toMatch(/Недостаточно/);
  });

  it('converts rubles to micro-USDT exactly, rounding up', () => {
    expect(usdtMicroForRub(8223, 82.23)).toBe(100_000_000);
    expect(usdtMicroForRub(500, 82.23)).toBe(6_080_506); // 6.0805058… → up
    expect(maxPayoutRub(100_000_000, 82.23)).toBe(8200);
    expect(usdtMicroForRub(maxPayoutRub(6_080_505, 82.23), 82.23)).toBeLessThanOrEqual(6_080_505);
  });
});

describe('status machine', () => {
  it('allows only the documented transitions', () => {
    expect(nextStatus('pending', 'mark_sent')).toBe('sent');
    expect(nextStatus('pending', 'confirm_user')).toBeNull();
    expect(nextStatus('disputed', 'confirm_admin')).toBe('completed');
    expect(nextStatus('disputed', 'mark_sent')).toBe('sent');
    expect(nextStatus('completed', 'reject')).toBeNull();
  });
});

describe('bank search', () => {
  it('finds by alias, transliteration and ё', () => {
    expect(searchBanks('тинькофф')[0].name).toBe('Т-Банк');
    expect(searchBanks('ozon')[0].name).toBe('Озон Банк');
    expect(searchBanks('сбер')[0].name).toBe('Сбербанк');
    expect(searchBanks('').length).toBeGreaterThan(150);
  });
});

import { parseInlineQuery, parseUsdt, shortUsdt } from './transfers.js';

describe('transfers parsing', () => {
  it('parses amounts', () => {
    expect(parseUsdt('10')).toBe(10_000_000);
    expect(parseUsdt('$2,5')).toBe(2_500_000);
    expect(parseUsdt('0.01 USDT')).toBe(10_000);
    expect(parseUsdt('abc')).toMatch(/Введите/);
    expect(shortUsdt(2_500_000)).toBe('2.5');
    expect(shortUsdt(10_000_000)).toBe('10');
  });

  it('parses inline queries', () => {
    expect(parseInlineQuery('')).toEqual({ kind: 'empty' });
    expect(parseInlineQuery('10 на кофе')).toEqual({ kind: 'amount', amountMicro: 10_000_000, comment: 'на кофе' });
    expect(parseInlineQuery('2.5 usdt')).toEqual({ kind: 'amount', amountMicro: 2_500_000, comment: null });
    expect(parseInlineQuery('c_AbCdEf1234')).toEqual({ kind: 'check', code: 'AbCdEf1234' });
    expect(parseInlineQuery('привет').kind).toBe('invalid');
  });
});
