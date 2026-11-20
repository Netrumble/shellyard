import { describe, expect, it } from 'vitest';
import { typedSeconds, typedTrim } from '../../src/shared/trim.js';

describe('typedSeconds', () => {
  it('reads decimal seconds, with a point or a comma, and nothing for an empty field', () => {
    expect(typedSeconds('0')).toBe(0);
    expect(typedSeconds(' 1.5 ')).toBe(1.5);
    expect(typedSeconds('1,5')).toBe(1.5);
    expect(typedSeconds('.5')).toBe(0.5);
    expect(typedSeconds('2.')).toBe(2);
    expect(typedSeconds('')).toBeNull();
    expect(typedSeconds('  ')).toBeNull();
  });
  it('refuses what is not a plain decimal number', () => {
    for (const t of ['0x10', '1e1', '-1', 'abc', '1.2.3', 'd', '.', 'Infinity']) expect(typedSeconds(t)).toBeUndefined();
  });
});

describe('typedTrim', () => {
  it('gives the cut the fields hold, rounded as the server keeps it', () => {
    expect(typedTrim('0', '')).toEqual({ start: 0, end: null });
    expect(typedTrim('', '2')).toEqual({ start: 0, end: 2 });
    expect(typedTrim('1.234', '2,5')).toEqual({ start: 1.23, end: 2.5 });
  });
  it('refuses a cut the server would refuse', () => {
    expect(typedTrim('2', '1')).toBeNull();
    expect(typedTrim('1.001', '1.004')).toBeNull();
    expect(typedTrim('5000', '')).toBeNull();
    expect(typedTrim('1e1', '')).toBeNull();
  });
});
