import { describe, expect, it } from 'vitest';
import { takeTokenFromHash, wsProtocols } from '../../src/web/token.js';

describe('takeTokenFromHash', () => {
  it('reads the token from the address fragment', () => {
    expect(takeTokenFromHash('#token=abc')).toBe('abc');
    expect(takeTokenFromHash('#other=1&token=abc')).toBe('abc');
    expect(takeTokenFromHash('token=abc')).toBe('abc');
  });
  it('returns null when there is none', () => {
    expect(takeTokenFromHash('')).toBeNull();
    expect(takeTokenFromHash('#x')).toBeNull();
    expect(takeTokenFromHash('#token=')).toBeNull();
  });
});

describe('wsProtocols', () => {
  it('offers the ttc protocol and the token', () => {
    expect(wsProtocols('abc')).toEqual(['ttc', 'ttc-token.abc']);
  });
});
