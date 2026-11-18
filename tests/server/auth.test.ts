import { describe, expect, it } from 'vitest';
import { hostAllowed, newToken, originAllowed, requestAuthorized, tokenFromProtocols } from '../../src/server/auth.js';

describe('hostAllowed', () => {
  it('accepts the loopback names on the server port', () => {
    expect(hostAllowed('127.0.0.1:7717', 7717)).toBe(true);
    expect(hostAllowed('localhost:7717', 7717)).toBe(true);
    expect(hostAllowed('LOCALHOST:7717', 7717)).toBe(true);
  });
  it('rejects everything else', () => {
    expect(hostAllowed('evil.com:7717', 7717)).toBe(false);
    expect(hostAllowed('127.0.0.1:7718', 7717)).toBe(false);
    expect(hostAllowed('127.0.0.1', 7717)).toBe(false);
    expect(hostAllowed('127.0.0.1.evil.com:7717', 7717)).toBe(false);
    expect(hostAllowed(undefined, 7717)).toBe(false);
    expect(hostAllowed('', 7717)).toBe(false);
  });
});

describe('originAllowed', () => {
  it('accepts its own origin', () => {
    expect(originAllowed('http://127.0.0.1:7717', 7717)).toBe(true);
    expect(originAllowed('http://localhost:7717', 7717)).toBe(true);
  });
  it('rejects other origins, null and none', () => {
    expect(originAllowed('https://evil.com', 7717)).toBe(false);
    expect(originAllowed('http://127.0.0.1:9999', 7717)).toBe(false);
    expect(originAllowed('https://127.0.0.1:7717', 7717)).toBe(false);
    expect(originAllowed('null', 7717)).toBe(false);
    expect(originAllowed(undefined, 7717)).toBe(false);
  });
});

describe('requestAuthorized', () => {
  const token = 'a'.repeat(64);
  it('accepts the token header', () => {
    expect(requestAuthorized({ 'x-shellyard-token': token }, token)).toBe(true);
  });
  it('rejects a wrong token, a token of another length, and no credentials', () => {
    expect(requestAuthorized({ 'x-shellyard-token': 'b'.repeat(64) }, token)).toBe(false);
    expect(requestAuthorized({ 'x-shellyard-token': 'short' }, token)).toBe(false);
    expect(requestAuthorized({ 'x-shellyard-token': '' }, token)).toBe(false);
    expect(requestAuthorized({}, token)).toBe(false);
  });
  it('does not accept a cookie: the browser would send one to every local port', () => {
    expect(requestAuthorized({ cookie: `shellyard_auth=${token}` }, token)).toBe(false);
  });
  it('never authorizes against an empty expected token', () => {
    expect(requestAuthorized({ 'x-shellyard-token': '' }, '')).toBe(false);
  });
});

describe('tokenFromProtocols', () => {
  it('reads the token offered beside the shellyard protocol', () => {
    expect(tokenFromProtocols('shellyard, shellyard-token.abc')).toBe('abc');
    expect(tokenFromProtocols('shellyard-token.abc,shellyard')).toBe('abc');
  });
  it('returns null when either part is missing', () => {
    expect(tokenFromProtocols('shellyard-token.abc')).toBeNull();
    expect(tokenFromProtocols('shellyard')).toBeNull();
    expect(tokenFromProtocols('shellyard, shellyard-token.')).toBeNull();
    expect(tokenFromProtocols('')).toBeNull();
    expect(tokenFromProtocols(undefined)).toBeNull();
  });
});

describe('newToken', () => {
  it('makes distinct 64-hex tokens', () => {
    const a = newToken();
    const b = newToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
