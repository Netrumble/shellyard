import { describe, expect, it } from 'vitest';
import { classifyHost, healthProof, isChallenge, newChallenge, newPageHost, newToken, originAllowed, pageOrigin, requestAuthorized, tokenFromProtocols } from '../../src/server/auth.js';

const PAGE = '0123456789abcdef0123456789abcdef.localhost';

describe('newPageHost', () => {
  it('is a new unguessable name under .localhost at every call', () => {
    const a = newPageHost();
    expect(a).toMatch(/^[0-9a-f]{32}\.localhost$/);
    expect(newPageHost()).not.toBe(a);
    expect(pageOrigin(a, 7717)).toBe(`http://${a}:7717`);
  });
});

describe('classifyHost', () => {
  it('knows the page host of this start, in any case', () => {
    expect(classifyHost(`${PAGE}:7717`, 7717, PAGE)).toBe('page');
    expect(classifyHost(`${PAGE.toUpperCase()}:7717`, 7717, PAGE)).toBe('page');
  });
  it('accepts the loopback address, which the command and the hooks use', () => {
    expect(classifyHost('127.0.0.1:7717', 7717, PAGE)).toBe('loopback');
  });
  it('recognises the page host of an earlier start', () => {
    expect(classifyHost(`${'f'.repeat(32)}.localhost:7717`, 7717, PAGE)).toBe('stale-page');
  });
  it('refuses everything else, localhost included', () => {
    for (const h of ['localhost:7717', 'LOCALHOST:7717', 'evil.com:7717', '127.0.0.1:7718', '127.0.0.1', '127.0.0.1.evil.com:7717', `${PAGE}:7718`, `x.${PAGE}:7717`, 'abc.localhost:7717', '', undefined]) {
      expect(classifyHost(h, 7717, PAGE)).toBe('foreign');
    }
  });
});

describe('originAllowed', () => {
  it('accepts only the page origin of this start', () => {
    expect(originAllowed(`http://${PAGE}:7717`, 7717, PAGE)).toBe(true);
    expect(originAllowed('http://127.0.0.1:7717', 7717, PAGE)).toBe(false);
    expect(originAllowed('http://localhost:7717', 7717, PAGE)).toBe(false);
    expect(originAllowed(`http://${'f'.repeat(32)}.localhost:7717`, 7717, PAGE)).toBe(false);
  });
  it('rejects other origins, null and none', () => {
    expect(originAllowed('https://evil.com', 7717, PAGE)).toBe(false);
    expect(originAllowed(`http://${PAGE}:9999`, 7717, PAGE)).toBe(false);
    expect(originAllowed(`https://${PAGE}:7717`, 7717, PAGE)).toBe(false);
    expect(originAllowed('null', 7717, PAGE)).toBe(false);
    expect(originAllowed(undefined, 7717, PAGE)).toBe(false);
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

describe('healthProof', () => {
  it('depends on the token and on the challenge', () => {
    const c = newChallenge();
    expect(isChallenge(c)).toBe(true);
    expect(healthProof('t1', c)).toMatch(/^[0-9a-f]{64}$/);
    expect(healthProof('t1', c)).toBe(healthProof('t1', c));
    expect(healthProof('t1', c)).not.toBe(healthProof('t2', c));
    expect(healthProof('t1', c)).not.toBe(healthProof('t1', newChallenge()));
  });
  it('accepts only a well-formed challenge', () => {
    expect(isChallenge('abc')).toBe(false);
    expect(isChallenge('A'.repeat(64))).toBe(false);
    expect(isChallenge(undefined)).toBe(false);
  });
});
