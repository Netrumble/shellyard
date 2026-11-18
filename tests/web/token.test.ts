import { describe, expect, it } from 'vitest';
import { takeTokenFromHash, wsProtocols } from '../../src/web/token.js';

describe('takeTokenFromHash', () => {
  const token = '0123456789abcdef'.repeat(4);
  it('reads the token from the address fragment', () => {
    expect(takeTokenFromHash(`#token=${token}`)).toBe(token);
    expect(takeTokenFromHash(`#other=1&token=${token}`)).toBe(token);
    expect(takeTokenFromHash(`token=${token}`)).toBe(token);
  });
  it('returns null when there is none', () => {
    expect(takeTokenFromHash('')).toBeNull();
    expect(takeTokenFromHash('#x')).toBeNull();
    expect(takeTokenFromHash('#token=')).toBeNull();
  });
  it('ignores anything that is not a token the server makes', () => {
    expect(takeTokenFromHash('#token=abc')).toBeNull();
    expect(takeTokenFromHash(`#token=${token.toUpperCase()}`)).toBeNull();
    expect(takeTokenFromHash(`#token=${token}x`)).toBeNull();
    expect(takeTokenFromHash(`#token=${token.slice(1)}%22`)).toBeNull();
  });
});

describe('wsProtocols', () => {
  it('offers the shellyard protocol and the token', () => {
    expect(wsProtocols('abc')).toEqual(['shellyard', 'shellyard-token.abc']);
  });
});
