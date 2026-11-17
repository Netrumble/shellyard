import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityMeter } from '../../src/server/activity.js';
import { parseStatusPayload, UsageStore, type StatusPayload } from '../../src/server/usage.js';
import { useTempHome } from '../helpers.js';

const at = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

function payload(over: Partial<StatusPayload> = {}): StatusPayload {
  return { modelId: 'claude-opus', modelName: 'Opus', costUsd: 0, tokensIn: 0, tokensOut: 0, fiveHour: null, sevenDay: null, ...over };
}
const noStory = { storyId: null, storyName: null };

describe('parseStatusPayload', () => {
  it('reads what Claude Code sends', () => {
    const p = parseStatusPayload({
      session_id: 'x',
      model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
      cost: { total_cost_usd: 0.00612855 },
      context_window: { total_input_tokens: 61787, total_output_tokens: 4 },
      rate_limits: { five_hour: { used_percentage: 58, resets_at: 1794921600 }, seven_day: { used_percentage: 31, resets_at: 1795075200 } },
    });
    expect(p).toEqual({
      modelId: 'claude-haiku-5-5',
      modelName: 'Haiku 5.5',
      costUsd: 0.00612855,
      tokensIn: 61787,
      tokensOut: 4,
      fiveHour: { usedPercentage: 58, resetsAt: 1794921600 * 1000 },
      sevenDay: { usedPercentage: 31, resetsAt: 1795075200 * 1000 },
    });
  });

  it('returns nulls for what is missing, instead of failing', () => {
    expect(parseStatusPayload({})).toEqual({ modelId: null, modelName: null, costUsd: null, tokensIn: null, tokensOut: null, fiveHour: null, sevenDay: null });
    expect(parseStatusPayload({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 5 } } })!.sevenDay).toBeNull();
  });

  it('keeps names to a sane length and percentages on the scale', () => {
    const p = parseStatusPayload({
      model: { id: 'm'.repeat(5000), display_name: 'n'.repeat(5000) },
      rate_limits: { five_hour: { used_percentage: 1e9, resets_at: 1794921600 } },
    })!;
    expect(p.modelId).toHaveLength(100);
    expect(p.modelName).toHaveLength(100);
    expect(p.fiveHour!.usedPercentage).toBe(100);
  });

  it('ignores values of the wrong type or out of range', () => {
    const p = parseStatusPayload({
      model: { id: 7, display_name: null },
      cost: { total_cost_usd: 'a lot' },
      context_window: { total_input_tokens: -5, total_output_tokens: Number.NaN },
      rate_limits: { five_hour: { used_percentage: 'x', resets_at: 1 }, seven_day: 'soon' },
    })!;
    expect(p).toEqual({ modelId: null, modelName: null, costUsd: null, tokensIn: null, tokensOut: null, fiveHour: null, sevenDay: null });
  });

  it('accepts a reset time already in milliseconds', () => {
    expect(parseStatusPayload({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1794921600000 } } })!.fiveHour!.resetsAt).toBe(1794921600000);
  });

  it('rejects what is not an object', () => {
    expect(parseStatusPayload('x')).toBeNull();
    expect(parseStatusPayload(null)).toBeNull();
    expect(parseStatusPayload([1])).toBeNull();
  });
});

describe('UsageStore', () => {
  const home = useTempHome();
  let now = 0;
  let file = '';
  let store: UsageStore;
  const make = (): UsageStore => new UsageStore({ now: () => now, file });

  beforeEach(() => {
    now = at(2026, 11, 17);
    file = join(home.dir(), 'usage.json');
    store = make();
  });

  it('starts with nothing: no limits, zero cost, empty tables', () => {
    expect(store.summary()).toEqual({
      limits: { fiveHour: null, sevenDay: null, readAt: null },
      today: { costUsd: 0, byModel: [], byStory: [] },
      week: { costUsd: 0, byModel: [], byStory: [] },
      month: { costUsd: 0, byModel: [], byStory: [] },
    });
  });

  it('turns a session’s running totals into amounts, counting each increase once', () => {
    store.record('s1', payload({ costUsd: 1, tokensIn: 100, tokensOut: 10 }), noStory);
    store.record('s1', payload({ costUsd: 1, tokensIn: 100, tokensOut: 10 }), noStory);
    store.record('s1', payload({ costUsd: 1.5, tokensIn: 180, tokensOut: 25 }), noStory);
    const { today } = store.summary();
    expect(today.costUsd).toBeCloseTo(1.5);
    expect(today.byModel).toEqual([{ key: 'claude-opus', label: 'Opus', tokensIn: 180, tokensOut: 25, costUsd: 1.5 }]);
  });

  it('adds sessions together and keeps models apart, most expensive first', () => {
    store.record('s1', payload({ costUsd: 1 }), noStory);
    store.record('s2', payload({ costUsd: 3, modelId: 'claude-haiku', modelName: 'Haiku' }), noStory);
    store.record('s3', payload({ costUsd: 0.5 }), noStory);
    const { today } = store.summary();
    expect(today.costUsd).toBeCloseTo(4.5);
    expect(today.byModel.map((l) => [l.label, l.costUsd])).toEqual([['Haiku', 3], ['Opus', 1.5]]);
  });

  it('attributes what comes after a model switch to the new model', () => {
    store.record('s1', payload({ costUsd: 1 }), noStory);
    store.record('s1', payload({ costUsd: 4, modelId: 'claude-haiku', modelName: 'Haiku' }), noStory);
    expect(store.summary().today.byModel.map((l) => [l.label, l.costUsd])).toEqual([['Haiku', 3], ['Opus', 1]]);
  });

  it('groups by story, with sessions outside any story under "No story"', () => {
    store.record('s1', payload({ costUsd: 2 }), { storyId: 'a', storyName: 'Payroll' });
    store.record('s2', payload({ costUsd: 1 }), noStory);
    expect(store.summary().today.byStory).toEqual([
      { key: 'a', label: 'Payroll', tokensIn: 0, tokensOut: 0, costUsd: 2 },
      { key: '', label: 'No area', tokensIn: 0, tokensOut: 0, costUsd: 1 },
    ]);
  });

  it('follows a session moved to another story, and a story that was renamed', () => {
    store.record('s1', payload({ costUsd: 2 }), { storyId: 'a', storyName: 'Payroll' });
    store.record('s1', payload({ costUsd: 5 }), { storyId: 'b', storyName: 'Absence' });
    store.record('s2', payload({ costUsd: 1 }), { storyId: 'a', storyName: 'Payroll export' });
    expect(store.summary().today.byStory.map((l) => [l.label, l.costUsd])).toEqual([['Absence', 3], ['Payroll export', 3]]);
  });

  it('never counts a negative amount when a running total goes down', () => {
    store.record('s1', payload({ costUsd: 5, tokensIn: 500 }), noStory);
    store.record('s1', payload({ costUsd: 2, tokensIn: 100 }), noStory);
    expect(store.summary().today.costUsd).toBeCloseTo(5);
    store.record('s1', payload({ costUsd: 3, tokensIn: 150 }), noStory);
    const { today } = store.summary();
    expect(today.costUsd).toBeCloseTo(6);
    expect(today.byModel[0]!.tokensIn).toBe(550);
  });

  it('ignores a payload with no figures, without losing the baseline', () => {
    store.record('s1', payload({ costUsd: 2 }), noStory);
    store.record('s1', payload({ costUsd: null, tokensIn: null, tokensOut: null }), noStory);
    store.record('s1', payload({ costUsd: 3 }), noStory);
    expect(store.summary().today.costUsd).toBeCloseTo(3);
  });

  it('puts what accrues after midnight on the new day', () => {
    now = at(2026, 11, 17, 23, 50);
    store.record('s1', payload({ costUsd: 4 }), noStory);
    now = at(2026, 11, 18, 0, 10);
    store.record('s1', payload({ costUsd: 5 }), noStory);
    const s = store.summary();
    expect(s.today.costUsd).toBeCloseTo(1);
    expect(s.week.costUsd).toBeCloseTo(5);
  });

  it('ends each window exactly: the 8th and the 31st day back are out', () => {
    now = at(2026, 10, 18);
    store.record('day-30', payload({ costUsd: 100 }), noStory); // 30 days before the 17th: outside "30 days"
    now = at(2026, 10, 19);
    store.record('day-29', payload({ costUsd: 10 }), noStory); // inside
    now = at(2026, 11, 10);
    store.record('day-7', payload({ costUsd: 5 }), noStory); // 7 days before: outside "7 days"
    now = at(2026, 11, 11);
    store.record('day-6', payload({ costUsd: 1 }), noStory); // inside
    now = at(2026, 11, 17);
    const s = store.summary();
    expect(s.week.costUsd).toBeCloseTo(1);
    expect(s.month.costUsd).toBeCloseTo(16);
  });

  describe('where clocks change for daylight saving', () => {
    let tz: string | undefined;
    beforeEach(() => {
      tz = process.env.TZ;
      process.env.TZ = 'Europe/Rome';
    });
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it('does not count the 25-hour day twice', () => {
      now = at(2026, 10, 25, 12);
      store.record('s1', payload({ costUsd: 10 }), noStory);
      now = at(2026, 10, 25, 23, 30);
      expect(store.summary().week.costUsd).toBeCloseTo(10);
      now = at(2026, 10, 27, 23, 30);
      expect(store.summary().week.costUsd).toBeCloseTo(10);
    });

    it('does not skip the 23-hour day', () => {
      now = at(2027, 3, 28, 12);
      store.record('s1', payload({ costUsd: 10 }), noStory);
      now = at(2027, 3, 29, 0, 30);
      expect(store.summary().week.costUsd).toBeCloseTo(10);
    });
  });

  it('covers 7 and 30 days including today, and nothing older', () => {
    now = at(2026, 10, 1);
    store.record('old', payload({ costUsd: 100 }), noStory);
    now = at(2026, 10, 25);
    store.record('mid', payload({ costUsd: 10 }), noStory);
    now = at(2026, 11, 11, 0, 30);
    store.record('edge', payload({ costUsd: 1 }), noStory);
    now = at(2026, 11, 17);
    store.record('new', payload({ costUsd: 0.5 }), noStory);
    const s = store.summary();
    expect(s.today.costUsd).toBeCloseTo(0.5);
    expect(s.week.costUsd).toBeCloseTo(1.5);
    expect(s.month.costUsd).toBeCloseTo(11.5);
  });

  it('keeps the latest limit reading and when it was read', () => {
    const r5 = now + 3_600_000;
    const r7 = now + 3 * 86_400_000;
    store.record('s1', payload({ fiveHour: { usedPercentage: 58, resetsAt: r5 }, sevenDay: { usedPercentage: 31, resetsAt: r7 } }), noStory);
    now += 60_000;
    store.record('s2', payload({ fiveHour: { usedPercentage: 60, resetsAt: r5 }, sevenDay: { usedPercentage: 31, resetsAt: r7 } }), noStory);
    expect(store.summary().limits).toEqual({ fiveHour: { usedPercentage: 60, resetsAt: r5 }, sevenDay: { usedPercentage: 31, resetsAt: r7 }, readAt: now });
  });

  it('a payload without limits does not erase the reading it had', () => {
    const r5 = now + 3_600_000;
    store.record('s1', payload({ fiveHour: { usedPercentage: 58, resetsAt: r5 } }), noStory);
    const readAt = now;
    now += 5000;
    store.record('s1', payload({ costUsd: 1 }), noStory);
    expect(store.summary().limits).toEqual({ fiveHour: { usedPercentage: 58, resetsAt: r5 }, sevenDay: null, readAt });
  });

  it('is not fooled by a reading for a limit window that has already ended', () => {
    const live = { usedPercentage: 20, resetsAt: now + 4 * 3_600_000 };
    store.record('active', payload({ fiveHour: live }), noStory);
    const readAt = now;
    now += 60_000;
    // An idle session re-sends what it knew an hour ago.
    store.record('idle', payload({ fiveHour: { usedPercentage: 95, resetsAt: now - 3_600_000 } }), noStory);
    expect(store.summary().limits).toEqual({ fiveHour: live, sevenDay: null, readAt });
  });

  it('prefers the reading of the later window over an earlier one', () => {
    const later = { usedPercentage: 5, resetsAt: now + 5 * 3_600_000 };
    store.record('a', payload({ fiveHour: later }), noStory);
    store.record('b', payload({ fiveHour: { usedPercentage: 90, resetsAt: now + 1 * 3_600_000 } }), noStory);
    expect(store.summary().limits.fiveHour).toEqual(later);
  });

  it('takes a new window once the stored one has ended', () => {
    store.record('a', payload({ fiveHour: { usedPercentage: 90, resetsAt: now + 1000 } }), noStory);
    now += 2000;
    const fresh = { usedPercentage: 3, resetsAt: now + 5 * 3_600_000 };
    store.record('a', payload({ fiveHour: fresh }), noStory);
    expect(store.summary().limits.fiveHour).toEqual(fresh);
  });

  it('cannot be made to alter every object in the process through a model or story name', () => {
    store.record('s1', payload({ costUsd: 5, modelId: '__proto__', modelName: 'evil' }), { storyId: 'constructor', storyName: 'evil story' });
    expect(({} as Record<string, unknown>).label).toBeUndefined();
    expect(({} as Record<string, unknown>).costUsd).toBeUndefined();
    const { today } = store.summary();
    expect(today.costUsd).toBeCloseTo(5);
    expect(today.byModel).toEqual([{ key: '__proto__', label: 'evil', tokensIn: 0, tokensOut: 0, costUsd: 5 }]);
    expect(today.byStory.map((l) => [l.key, l.costUsd])).toEqual([['constructor', 5]]);
    store.flush();
    expect(make().summary().today.costUsd).toBeCloseTo(5);
  });

  it('refuses an absurd jump instead of adding it to the totals', () => {
    store.record('s1', payload({ costUsd: 1 }), noStory);
    store.record('s1', payload({ costUsd: 1_000_000 }), noStory);
    store.record('s1', payload({ costUsd: 0 }), noStory);
    store.record('s1', payload({ costUsd: 1_000_000 }), noStory);
    expect(store.summary().today.costUsd).toBeCloseTo(1);
    store.record('s1', payload({ costUsd: 1_000_000.5 }), noStory);
    expect(store.summary().today.costUsd).toBeCloseTo(1.5);
    store.record('s2', payload({ tokensIn: 1e15 }), noStory);
    expect(store.summary().today.byModel[0]!.tokensIn).toBe(0);
  });

  it('announces changes, and stays quiet when nothing changed', () => {
    let changes = 0;
    store.onChange(() => changes++);
    store.record('s1', payload({ costUsd: 1 }), noStory);
    store.record('s1', payload({ costUsd: 1 }), noStory);
    expect(changes).toBe(1);
    store.record('s1', payload({ costUsd: 1, fiveHour: { usedPercentage: 5, resetsAt: now + 1000 } }), noStory);
    expect(changes).toBe(2);
  });

  describe('on disk', () => {
    it('remembers amounts and limits across a restart', () => {
      store.record('s1', payload({ costUsd: 2, fiveHour: { usedPercentage: 58, resetsAt: now + 3_600_000 } }), { storyId: 'a', storyName: 'Payroll' });
      store.flush();
      const again = make();
      expect(again.summary().today.costUsd).toBeCloseTo(2);
      expect(again.summary().today.byStory[0]!.label).toBe('Payroll');
      expect(again.summary().limits.fiveHour).toEqual({ usedPercentage: 58, resetsAt: now + 3_600_000 });
    });

    it('starts from nothing and keeps a corrupt file aside', () => {
      writeFileSync(file, '{ broken');
      const s = make();
      expect(s.summary().today.costUsd).toBe(0);
      s.record('s1', payload({ costUsd: 1 }), noStory);
      s.flush();
      expect(readFileSync(file + '.bad', 'utf8')).toBe('{ broken');
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2);
    });

    it('sets aside a file from the older way of counting, so nothing is counted twice', () => {
      const old = JSON.stringify({ version: 1, days: { '2026-11-17': { models: { m: { label: 'M', costUsd: 9, tokensIn: 1, tokensOut: 1 } }, stories: {} } } });
      writeFileSync(file, old);
      const s = make();
      expect(s.summary().today.costUsd).toBe(0);
      expect(readFileSync(file + '.old', 'utf8')).toBe(old);
    });

    it('does not overwrite a file written by a newer version', () => {
      const newer = JSON.stringify({ version: 99, something: 'else' });
      writeFileSync(file, newer);
      const s = make();
      s.record('s1', payload({ costUsd: 1 }), noStory);
      s.flush();
      expect(readFileSync(file + '.newer', 'utf8')).toBe(newer);
    });

    it('tolerates a file whose content has the wrong shape', () => {
      writeFileSync(file, JSON.stringify({ version: 2, days: 'x', files: [1, 2], names: 5, limits: 7 }));
      const s = make();
      expect(s.summary().today.costUsd).toBe(0);
      s.record('s1', payload({ costUsd: 1 }), noStory);
      expect(s.summary().today.costUsd).toBeCloseTo(1);
    });

    it('drops days older than 90 when it saves', () => {
      now = at(2026, 6, 1);
      store.record('ancient', payload({ costUsd: 9 }), noStory);
      now = at(2026, 11, 17);
      store.record('new', payload({ costUsd: 1 }), noStory);
      store.flush();
      const days = Object.keys(JSON.parse(readFileSync(file, 'utf8')).days);
      expect(days).toEqual(['2026-11-17']);
    });

    it('writes nothing until there is something to write', () => {
      store.flush();
      expect(existsSync(file)).toBe(false);
    });

    it('does not rewrite the file for reports that change nothing', () => {
      store.record('s1', payload({ costUsd: 1 }), noStory);
      store.flush();
      writeFileSync(file, 'marker');
      store.record('s1', payload({ costUsd: 1 }), noStory);
      store.flush();
      expect(readFileSync(file, 'utf8')).toBe('marker');
    });
  });
});

describe('ActivityMeter', () => {
  it('reports the bytes printed in the last second, per session', () => {
    let now = 10_000;
    const m = new ActivityMeter(() => now);
    m.add('a', 100);
    now += 400;
    m.add('a', 50);
    m.add('b', 7);
    expect(m.rates()).toEqual({ a: 150, b: 7 });
    now += 700;
    expect(m.rates()).toEqual({ a: 50, b: 7 });
    now += 400;
    expect(m.rates()).toEqual({});
  });

  it('stays small and quick however long nobody asks for the rates', () => {
    let now = 0;
    const m = new ActivityMeter(() => now);
    // Hours of output with no browser connected: nothing reads the rates meanwhile.
    for (let i = 0; i < 300_000; i++) {
      now += 50;
      m.add('a', 10);
    }
    expect(m.sampleCount()).toBeLessThan(100);
    const started = Date.now();
    expect(m.rates()).toEqual({ a: 200 });
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('forgets a session', () => {
    const m = new ActivityMeter(() => 0);
    m.add('a', 5);
    m.forget('a');
    expect(m.rates()).toEqual({});
  });
});
