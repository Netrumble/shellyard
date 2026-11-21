import { describe, expect, it } from 'vitest';
import { describeThrown, freshErrors, isNoise, SendGate } from '../../src/web/page-errors.js';
import type { ErrorReport } from '../../src/shared/types.js';

const report = (id: string, count = 1, seen = false): ErrorReport => ({
  id,
  source: 'server',
  message: 'm',
  context: null,
  file: `/e/${id}.log`,
  at: 1,
  count,
  lastAt: 1,
  seen,
});

describe('isNoise', () => {
  it('ignores what browsers and extensions make', () => {
    expect(isNoise('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isNoise('Script error.')).toBe(true);
    expect(isNoise('boom', 'chrome-extension://abc/x.js')).toBe(true);
    expect(isNoise('TypeError: x is undefined', 'http://h.localhost:7717/assets/app.js')).toBe(false);
  });
});

describe('describeThrown', () => {
  it('reads an Error, a string and nothing', () => {
    const e = new RangeError('too far');
    expect(describeThrown(e, 'f')).toEqual({ message: 'RangeError: too far', stack: e.stack });
    expect(describeThrown('plain', 'f')).toEqual({ message: 'plain', stack: null });
    expect(describeThrown(undefined, 'fallback')).toEqual({ message: 'fallback', stack: null });
  });
});

describe('SendGate', () => {
  it('lets the same error through once in a while, and not too many in all', () => {
    const g = new SendGate();
    expect(g.allow('a', 0)).toBe(true);
    expect(g.allow('a', 1000)).toBe(false);
    expect(g.allow('a', 31_000)).toBe(true);
    for (let i = 0; i < 28; i++) g.allow(`x${i}`, 40_000);
    expect(g.allow('new', 40_000)).toBe(false);
  });
});

describe('freshErrors', () => {
  it('gives new errors and those that happened again, unseen', () => {
    const prev = [report('a'), report('b')];
    const next = [report('c'), report('a', 2), report('b'), report('d', 1, true)];
    expect(freshErrors(prev, next).map((r) => r.id)).toEqual(['c', 'a']);
  });
});
