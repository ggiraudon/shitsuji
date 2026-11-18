import { describe, expect, it } from 'vitest';
import { tokenMatches } from '../src/auth.js';

describe('sandboxd token check (F08, S45)', () => {
  it('accepts only the exact token', () => {
    expect(tokenMatches('secret-token', 'secret-token')).toBe(true);
    expect(tokenMatches('secret-token', 'secret-toke')).toBe(false);
    expect(tokenMatches('secret-token', 'secret-token ')).toBe(false);
    expect(tokenMatches('secret-token', '')).toBe(false);
    expect(tokenMatches('secret-token', undefined)).toBe(false);
  });

  it('does not care about the token length', () => {
    expect(tokenMatches('a', 'a'.repeat(100))).toBe(false);
    expect(tokenMatches('a'.repeat(100), 'a')).toBe(false);
  });
});
