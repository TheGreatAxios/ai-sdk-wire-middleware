import { describe, expect, test } from 'bun:test';
import {
  countTokens,
  countTokensMany,
  DEFAULT_ENCODING,
  TOKENIZER_NAME,
} from '../bench/lib/tokenizer.ts';

describe('tokenizer (js-tiktoken / o200k_base)', () => {
  test('empty string is 0 tokens', () => {
    expect(countTokens('')).toBe(0);
  });

  test('plain ASCII tokenizes deterministically', () => {
    const a = countTokens('hello world');
    const b = countTokens('hello world');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(5);
  });

  test('JSON tool-call form is more tokens than compact form', () => {
    const json = JSON.stringify({
      type: 'tool_use',
      id: 'toolu_x',
      name: 'getWeather',
      input: { location: 'Austin', units: 'metric' },
    });
    const compact = '<call>getWeather location="Austin" units=metric</call>';
    expect(countTokens(json)).toBeGreaterThan(countTokens(compact));
  });

  test('countTokensMany sums', () => {
    const total = countTokensMany(['hello', ' ', 'world']);
    const single = countTokens('hello') + countTokens(' ') + countTokens('world');
    expect(total).toBe(single);
  });

  test('exposes pinned encoding name in artifacts', () => {
    expect(DEFAULT_ENCODING).toBe('o200k_base');
    expect(TOKENIZER_NAME).toBe('js-tiktoken/o200k_base');
  });
});
