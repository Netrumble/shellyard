import { describe, expect, it } from 'vitest';
import { resolveEffects } from '../../src/web/effects.js';
import { durationLabel, formatTokens, formatUsd, limitDisplay, needleAngle, odometerDigits, revLevel, shiftLights, zoneOf } from '../../src/web/gauges.js';

describe('needleAngle', () => {
  it('sweeps 240 degrees, from -120 at zero to +120 at full scale', () => {
    expect(needleAngle(0, 100)).toBe(-120);
    expect(needleAngle(50, 100)).toBe(0);
    expect(needleAngle(100, 100)).toBe(120);
    expect(needleAngle(25, 100)).toBe(-60);
  });
  it('stops at the ends of the scale', () => {
    expect(needleAngle(-5, 100)).toBe(-120);
    expect(needleAngle(250, 100)).toBe(120);
  });
  it('rests at zero for values that make no sense', () => {
    expect(needleAngle(Number.NaN, 100)).toBe(-120);
    expect(needleAngle(10, 0)).toBe(-120);
    expect(needleAngle(10, -3)).toBe(-120);
    expect(needleAngle(Number.POSITIVE_INFINITY, 100)).toBe(120);
  });
});

describe('zoneOf', () => {
  it('is ok below 70, a warning from 70, danger from 90', () => {
    expect(zoneOf(0)).toBe('ok');
    expect(zoneOf(69.9)).toBe('ok');
    expect(zoneOf(70)).toBe('warn');
    expect(zoneOf(89.9)).toBe('warn');
    expect(zoneOf(90)).toBe('danger');
    expect(zoneOf(140)).toBe('danger');
  });
});

describe('shiftLights', () => {
  const lit = (pct: number): string => shiftLights(pct).map((l) => l[0]).join('');
  it('has ten lights: five green, three amber, two red', () => {
    expect(shiftLights(100)).toEqual(['green', 'green', 'green', 'green', 'green', 'amber', 'amber', 'amber', 'red', 'red']);
  });
  it('lights them in proportion to the percentage', () => {
    expect(lit(0)).toBe('oooooooooo');
    expect(lit(9)).toBe('oooooooooo');
    expect(lit(10)).toBe('gooooooooo');
    expect(lit(58)).toBe('gggggooooo');
    expect(lit(75)).toBe('gggggaaooo');
    expect(lit(95)).toBe('gggggaaaro');
    expect(lit(100)).toBe('gggggaaarr');
    expect(lit(400)).toBe('gggggaaarr');
    expect(lit(Number.NaN)).toBe('oooooooooo');
  });
});

describe('limitDisplay', () => {
  const now = 1_000_000_000_000;
  const hour = 3_600_000;
  it('says there is no data when there is none', () => {
    expect(limitDisplay(null, null, now)).toEqual({ state: 'no-data', pct: 0, resetsIn: '', age: '' });
  });
  it('shows a fresh reading with the time left and its age', () => {
    expect(limitDisplay({ usedPercentage: 58.4, resetsAt: now + hour + 12 * 60_000 }, now - 20_000, now)).toEqual({ state: 'ok', pct: 58, resetsIn: '1h 12m', age: '20s ago' });
  });
  it('calls a reading taken this instant "just now"', () => {
    expect(limitDisplay({ usedPercentage: 40, resetsAt: now + hour }, now, now).age).toBe('just now');
  });
  it('tells how old an old reading is', () => {
    expect(limitDisplay({ usedPercentage: 40, resetsAt: now + hour }, now - 3 * hour, now).age).toBe('3h 0m ago');
  });
  it('does not show a reading as current once its limit has reset', () => {
    expect(limitDisplay({ usedPercentage: 97, resetsAt: now - 1000 }, now - 2 * hour, now)).toEqual({ state: 'expired', pct: 0, resetsIn: '', age: '2h 0m ago' });
  });
  it('keeps the percentage within the scale', () => {
    expect(limitDisplay({ usedPercentage: 130, resetsAt: now + hour }, now, now).pct).toBe(100);
  });
});

describe('revLevel', () => {
  it('is zero at rest and full at a heavy stream', () => {
    expect(revLevel(0)).toBe(0);
    expect(revLevel(-10)).toBe(0);
    expect(revLevel(20_000)).toBe(1);
    expect(revLevel(5_000_000)).toBe(1);
  });
  it('rises quickly at first, so a trickle is visible', () => {
    expect(revLevel(20)).toBeGreaterThan(0.2);
    expect(revLevel(20)).toBeLessThan(0.4);
    expect(revLevel(600)).toBeGreaterThan(revLevel(20));
    expect(revLevel(6000)).toBeGreaterThan(revLevel(600));
    expect(revLevel(6000)).toBeLessThan(1);
  });
});

describe('formatting', () => {
  it('formats dollars', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('$0.00');
    expect(formatUsd(14.2)).toBe('$14.20');
    expect(formatUsd(999.994)).toBe('$999.99');
    expect(formatUsd(1204.4)).toBe('$1,204');
  });
  it('formats token counts compactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(999_999)).toBe('1.0M');
  });
  it('formats durations with two units at most', () => {
    expect(durationLabel(0)).toBe('now');
    expect(durationLabel(-50)).toBe('now');
    expect(durationLabel(45_000)).toBe('45s');
    expect(durationLabel(72 * 60_000)).toBe('1h 12m');
    expect(durationLabel(5 * 60_000 + 3000)).toBe('5m');
    expect(durationLabel(76 * 3_600_000)).toBe('3d 4h');
  });
  it('splits a figure into one column per character', () => {
    expect(odometerDigits('$14.20')).toEqual(['$', '1', '4', '.', '2', '0']);
    expect(odometerDigits('')).toEqual([]);
  });
});

describe('effects', () => {
  it('uses the saved level when there is one', () => {
    expect(resolveEffects('off', false)).toBe('off');
    expect(resolveEffects('reduced', false)).toBe('reduced');
    expect(resolveEffects('full', true)).toBe('full');
  });
  it('otherwise follows the system preference for reduced motion', () => {
    expect(resolveEffects(null, false)).toBe('full');
    expect(resolveEffects(null, true)).toBe('reduced');
    expect(resolveEffects('nonsense', true)).toBe('reduced');
  });
});
