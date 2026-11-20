import { describe, expect, it } from 'vitest';
import { answerTime, blockedTime, compareAnswer, compareBlocked, timelineBars, timelineSummary } from '../../src/web/flow-text.js';

const MIN = 60_000;

describe('blockedTime and answerTime', () => {
  it('reads like a person would say it', () => {
    expect(blockedTime(0)).toBe('0 min');
    expect(blockedTime(27 * MIN + 20_000)).toBe('27 min');
    expect(blockedTime(95 * MIN)).toBe('1 h 35 min');
    expect(answerTime(130_000)).toBe('2m 10s');
    expect(answerTime(45_000)).toBe('45s');
    expect(answerTime(null)).toBe('—');
  });
});

describe('compareBlocked and compareAnswer', () => {
  it('says how today compares with the days before', () => {
    expect(compareBlocked(27 * MIN, 41.5 * MIN)).toEqual({ text: '−35% vs last week', better: true });
    expect(compareBlocked(30 * MIN, 20 * MIN)).toEqual({ text: '+50% vs last week', better: false });
    expect(compareAnswer(130_000, 178_000)).toEqual({ text: '−48 s vs last week', better: true });
    expect(compareAnswer(200_000, 100_000)).toEqual({ text: '+1m 40s vs last week', better: false });
  });

  it('says nothing without something to compare with', () => {
    expect(compareBlocked(10, null)).toBeNull();
    expect(compareBlocked(10, 0)).toBeNull();
    expect(compareAnswer(null, 100)).toBeNull();
    expect(compareAnswer(100, null)).toBeNull();
  });
});

describe('timelineBars', () => {
  it('places each segment as a share of the window, the open one up to now', () => {
    const from = 0;
    const to = 60 * MIN;
    expect(
      timelineBars(
        [
          { state: 'working', from: 0, to: 15 * MIN },
          { state: 'needs', from: 15 * MIN, to: 30 * MIN },
          { state: 'idle', from: 30 * MIN, to: null },
        ],
        from,
        to,
      ),
    ).toEqual([
      { state: 'working', left: 0, width: 25 },
      { state: 'needs', left: 25, width: 25 },
      { state: 'idle', left: 50, width: 50 },
    ]);
  });

  it('leaves out what is too thin to see, and clips to the window', () => {
    expect(timelineBars([{ state: 'needs', from: -10 * MIN, to: 1000 }], 0, 60 * MIN)).toEqual([]);
    expect(timelineBars([{ state: 'needs', from: -10 * MIN, to: 6 * MIN }], 0, 60 * MIN)).toEqual([{ state: 'needs', left: 0, width: 10 }]);
  });
});

describe('timelineSummary', () => {
  it('says in words what the bar shows', () => {
    expect(
      timelineSummary(
        [
          { state: 'working', from: 0, to: 40 * MIN },
          { state: 'needs', from: 40 * MIN, to: 46 * MIN },
          { state: 'working', from: 46 * MIN, to: null },
        ],
        0,
        60 * MIN,
      ),
    ).toBe('working 54 min, waiting for you 6 min');
  });
});
