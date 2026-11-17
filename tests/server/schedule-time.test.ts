import { describe, expect, it } from 'vitest';
import { nextRun, parseCron } from '../../src/server/schedule-time.js';

// Times are local, as the person who writes "every day at 08:30" means them.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe('nextRun', () => {
  it('runs a one-off at its time, and never again', () => {
    expect(nextRun({ kind: 'once', at: at(2026, 11, 20, 9) }, at(2026, 11, 17, 12))).toBe(at(2026, 11, 20, 9));
    expect(nextRun({ kind: 'once', at: at(2026, 11, 20, 9) }, at(2026, 11, 20, 9))).toBeNull();
  });

  it('finds the next chosen weekday at the chosen time', () => {
    // 17 November 2026 is a Tuesday.
    const weekdays = { kind: 'weekly' as const, time: '08:30', days: [1, 2, 3, 4, 5] };
    expect(nextRun(weekdays, at(2026, 11, 17, 7))).toBe(at(2026, 11, 17, 8, 30));
    expect(nextRun(weekdays, at(2026, 11, 17, 8, 30))).toBe(at(2026, 11, 18, 8, 30));
    expect(nextRun(weekdays, at(2026, 11, 20, 9))).toBe(at(2026, 11, 23, 8, 30));
    expect(nextRun({ kind: 'weekly', time: '23:59', days: [0] }, at(2026, 11, 17, 7))).toBe(at(2026, 11, 22, 23, 59));
  });

  it('counts an interval from the moment given', () => {
    expect(nextRun({ kind: 'interval', minutes: 90 }, at(2026, 11, 17, 10))).toBe(at(2026, 11, 17, 11, 30));
  });

  it('follows a cron expression', () => {
    expect(nextRun({ kind: 'cron', expr: '*/15 9-17 * * 1-5' }, at(2026, 11, 17, 9, 16))).toBe(at(2026, 11, 17, 9, 30));
    expect(nextRun({ kind: 'cron', expr: '*/15 9-17 * * 1-5' }, at(2026, 11, 20, 17, 45))).toBe(at(2026, 11, 23, 9, 0));
    expect(nextRun({ kind: 'cron', expr: '0 6 1 * *' }, at(2026, 11, 17, 9))).toBe(at(2026, 12, 1, 6));
    expect(nextRun({ kind: 'cron', expr: '30 2 29 2 *' }, at(2026, 11, 17, 9))).toBe(at(2028, 2, 29, 2, 30));
  });

  it('runs on either day when a cron expression names both a day of the month and a weekday', () => {
    // The 20th is a Friday; Monday the 23rd comes after it.
    const when = { kind: 'cron' as const, expr: '0 12 20 * 1' };
    expect(nextRun(when, at(2026, 11, 17, 13))).toBe(at(2026, 11, 20, 12));
    expect(nextRun(when, at(2026, 11, 20, 12))).toBe(at(2026, 11, 23, 12));
  });

  it('gives nothing for an expression that never comes', () => {
    expect(nextRun({ kind: 'cron', expr: '0 0 31 2 *' }, at(2026, 11, 17))).toBeNull();
    expect(nextRun({ kind: 'cron', expr: 'nonsense' }, at(2026, 11, 17))).toBeNull();
  });
});

describe('parseCron', () => {
  it('reads five fields with lists, ranges and steps', () => {
    const c = parseCron('0,30 8-10 * 1-12/3 7')!;
    expect(c.minutes).toEqual([0, 30]);
    expect(c.hours).toEqual([8, 9, 10]);
    expect(c.months).toEqual([1, 4, 7, 10]);
    // 7 is Sunday too.
    expect(c.weekdays).toEqual([0]);
    expect(c.anyDay).toBe(true);
    expect(c.anyWeekday).toBe(false);
  });
  it('refuses what is not a cron expression', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *']) {
      expect(parseCron(bad), bad).toBeNull();
    }
  });
});
