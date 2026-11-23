import type { Schedule, ScheduleRun } from '../../src/shared/types.js';
import { describe, expect, it } from 'vitest';
import { describeWhen, fromLocalInput, newlyStuck, outcomeText, runResult, spanLabel, toLocalInput } from '../../src/web/schedule-text.js';

describe('describeWhen', () => {
  it('says a weekly timetable the way a person would', () => {
    expect(describeWhen({ kind: 'weekly', time: '08:30', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day at 08:30');
    expect(describeWhen({ kind: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] })).toBe('Weekdays at 08:30');
    expect(describeWhen({ kind: 'weekly', time: '18:00', days: [1, 3] })).toBe('Mon, Wed at 18:00');
    expect(describeWhen({ kind: 'weekly', time: '09:00', days: [0, 6] })).toBe('Sat, Sun at 09:00');
  });
  it('says an interval in its largest whole unit', () => {
    expect(describeWhen({ kind: 'interval', minutes: 45 })).toBe('Every 45 minutes');
    expect(describeWhen({ kind: 'interval', minutes: 60 })).toBe('Every hour');
    expect(describeWhen({ kind: 'interval', minutes: 180 })).toBe('Every 3 hours');
    expect(describeWhen({ kind: 'interval', minutes: 1440 })).toBe('Every day');
    expect(describeWhen({ kind: 'interval', minutes: 2880 })).toBe('Every 2 days');
    expect(describeWhen({ kind: 'interval', minutes: 90 })).toBe('Every 90 minutes');
  });
  it('shows a cron expression as written, and a one-off with its date', () => {
    expect(describeWhen({ kind: 'cron', expr: '0 6 1 * *' })).toBe('Cron: 0 6 1 * *');
    expect(describeWhen({ kind: 'once', at: new Date(2026, 10, 20, 9, 5).getTime() })).toMatch(/^Once, .*2026.*09:05$/);
  });
});

describe('outcomeText', () => {
  it('names each outcome of a run in plain words', () => {
    expect(outcomeText('started')).toBe('Started, prompt on its way');
    expect(outcomeText('delivered')).toBe('Prompt given');
    expect(outcomeText('undelivered')).toBe('Session open, prompt not given');
    expect(outcomeText('failed')).toBe('Could not start');
    expect(outcomeText('skipped')).toBe('Skipped');
  });
});

describe('the date-and-time field', () => {
  it('turns a moment into the value of the field and back', () => {
    const t = new Date(2026, 10, 20, 9, 5).getTime();
    expect(toLocalInput(t)).toBe('2026-11-20T09:05');
    expect(fromLocalInput('2026-11-20T09:05')).toBe(t);
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('not a date')).toBeNull();
  });
});

describe('runResult', () => {
  const MIN = 60_000;
  const base: ScheduleRun = { at: 0, outcome: 'delivered', detail: null, sessionId: 's', manual: false, finishedAt: null, endedBy: null, costUsd: null, blockedMs: 0, blockedSince: null, stuckAt: null };

  it('says how long a finished run took, what it cost and how long it waited on you', () => {
    expect(runResult({ ...base, finishedAt: 4 * MIN, endedBy: 'turn', costUsd: 0.4234, blockedMs: 2 * MIN }, 10 * MIN)).toEqual({ text: 'Done in 4m · $0.42 · waited on you 2m', tone: 'tone-ok', needsYou: false });
    expect(runResult({ ...base, finishedAt: 30_000, endedBy: 'turn', costUsd: 12.6 }, MIN).text).toBe('Done in 30s · $13');
    expect(runResult({ ...base, finishedAt: 6 * MIN, endedBy: 'session' }, 10 * MIN)).toMatchObject({ text: 'Ended after 6m, before finishing', tone: 'tone-muted' });
    expect(runResult({ ...base, endedBy: 'restart', costUsd: 0.2 }, 10 * MIN)).toMatchObject({ text: 'Stopped with ShellYard, before finishing · $0.20', tone: 'tone-muted' });
    expect(runResult({ ...base, endedBy: 'unknown' }, 10 * MIN).text).toBe('');
  });

  it('leaves out a wait under a second, and says "under 1s" rather than "now"', () => {
    expect(runResult({ ...base, finishedAt: 400, endedBy: 'turn', blockedMs: 400 }, MIN).text).toBe('Done in under 1s');
    expect(runResult({ ...base, finishedAt: 5 * MIN, endedBy: 'turn', blockedMs: 1_000 }, 10 * MIN).text).toBe('Done in 5m · waited on you 1s');
    // A browser clock behind the server's gives a negative span: the shortest.
    expect(runResult({ ...base, blockedSince: 2 * MIN }, MIN).text).toBe('Waiting on you for under 1s');
    expect(spanLabel(-5_000)).toBe('under 1s');
  });

  it('says a run waits on you, more loudly once it is stuck', () => {
    const waiting = { ...base, blockedSince: 2 * MIN, costUsd: 0.1 };
    expect(runResult(waiting, 14 * MIN)).toEqual({ text: 'Waiting on you for 12m · $0.10', tone: 'tone-warn', needsYou: true });
    expect(runResult({ ...waiting, stuckAt: 12 * MIN }, 14 * MIN).tone).toBe('tone-dead');
  });

  it('says a run is working, and nothing for runs that never had a session at work', () => {
    expect(runResult({ ...base, outcome: 'started' }, 3 * MIN).text).toBe('Working for 3m');
    expect(runResult({ ...base, outcome: 'failed', sessionId: null }, MIN).text).toBe('');
    expect(runResult({ ...base, outcome: 'undelivered' }, MIN).text).toBe('');
    // The session ended while the prompt was on its way, which was then found not given.
    expect(runResult({ ...base, outcome: 'undelivered', finishedAt: 20_000, endedBy: 'session' }, MIN).text).toBe('');
  });
});

describe('newlyStuck', () => {
  const run = (over: Partial<ScheduleRun>): ScheduleRun => ({ at: 1, outcome: 'delivered', detail: null, sessionId: 's', manual: false, finishedAt: null, endedBy: null, costUsd: null, blockedMs: 0, blockedSince: 1, stuckAt: null, ...over });
  const schedule = (runs: ScheduleRun[]) => ({ id: 'a', name: 'Nightly', runs }) as unknown as Schedule;

  it('finds a run once, when it becomes stuck while still waiting', () => {
    const before = [schedule([run({})])];
    const after = [schedule([run({ stuckAt: 5 })])];
    expect(newlyStuck(before, after).map((x) => x.run.stuckAt)).toEqual([5]);
    expect(newlyStuck(after, after)).toEqual([]);
    expect(newlyStuck(before, [schedule([run({ stuckAt: 5, blockedSince: null })])])).toEqual([]);
  });
});
