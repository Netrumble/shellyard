import { describe, expect, it } from 'vitest';
import { clampAreaSize, parseAreaSizes, withAreaSize } from '../../src/web/board-sizes.js';

describe('sizes of the areas on the board', () => {
  it('keeps a size within sensible limits and on whole pixels', () => {
    expect(clampAreaSize({ width: 412.6, height: 300.2 })).toEqual({ width: 413, height: 300 });
    expect(clampAreaSize({ width: 10, height: 10 })).toEqual({ width: 220, height: 130 });
    expect(clampAreaSize({ width: 99999, height: 99999 })).toEqual({ width: 2400, height: 1600 });
  });

  it('reads what was stored, dropping anything that is not a size', () => {
    const raw = JSON.stringify({ a: { width: 400, height: 300 }, b: { width: 'wide' }, c: 5, d: { width: 5, height: 5 }, __proto__: { width: 1, height: 1 } });
    expect(parseAreaSizes(raw)).toEqual({ a: { width: 400, height: 300 }, d: { width: 220, height: 130 } });
  });

  it('starts empty when nothing usable was stored', () => {
    expect(parseAreaSizes(null)).toEqual({});
    expect(parseAreaSizes('{ broken')).toEqual({});
    expect(parseAreaSizes('[1,2]')).toEqual({});
  });

  it('records the size of one area without touching the others', () => {
    const before = { a: { width: 400, height: 300 } };
    const after = withAreaSize(before, 'b', { width: 500.4, height: 200 });
    expect(after).toEqual({ a: { width: 400, height: 300 }, b: { width: 500, height: 200 } });
    expect(before).toEqual({ a: { width: 400, height: 300 } });
  });

  it('forgets a size when asked to', () => {
    expect(withAreaSize({ a: { width: 400, height: 300 } }, 'a', null)).toEqual({});
  });
});
