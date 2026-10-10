import { afterEach, describe, expect, it } from 'vitest';
import { configureEmoji, em, esc } from './emoji.js';

describe('emoji', () => {
  afterEach(() => configureEmoji(false, ''));

  it('plain emoji until custom ones are switched on and set', () => {
    expect(em('success')).toBe('✅');
    configureEmoji(false, 'success=5370869711888194012');
    expect(em('success')).toBe('✅');
    configureEmoji(true, 'success=5370869711888194012, nope=1, deposit=abc');
    expect(em('success')).toBe('<tg-emoji emoji-id="5370869711888194012">✅</tg-emoji>');
    expect(em('deposit')).toBe('💰');
  });

  it('escapes user text so it cannot inject markup', () => {
    expect(esc('<b>Tom & Jerry</b>')).toBe('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
  });
});
