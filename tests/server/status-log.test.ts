import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { median, StatusLog } from '../../src/server/status-log.js';
import type { Reason, SessionInfo, Status } from '../../src/shared/types.js';
import { FakeClock, useTempHome } from '../helpers.js';
import { session } from '../web/session-fixture.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('median', () => {
  it('is the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(3);
  });
});

describe('StatusLog', () => {
  const home = useTempHome();
  let clock: FakeClock;
  let log: StatusLog;
  // Noon of a fixed day, so that minutes and hours never cross midnight.
  const NOON = new Date(2026, 10, 20, 12, 0, 0).getTime();

  const as = (id: string, status: Status, reason: Reason = null): SessionInfo => ({ ...session(id, status, reason), name: id.toUpperCase() });

  beforeEach(() => {
    clock = new FakeClock();
    clock.advance(NOON - clock.now());
    log = new StatusLog({ now: clock.now, file: join(home.dir(), 'flow.json') });
  });

  it('adds up the time sessions were blocked on the user, and how long each answer took', () => {
    log.observe([as('a', 'working')]);
    clock.advance(MIN);
    log.observe([as('a', 'attention', 'blocked')]);
    clock.advance(2 * MIN);
    log.observe([as('a', 'working')]); // answered after 2 min
    clock.advance(MIN);
    log.observe([as('a', 'attention', 'blocked')]);
    clock.advance(4 * MIN);
    log.observe([as('a', 'working')]); // answered after 4 min
    const s = log.summary();
    expect(s.today).toMatchObject({ blockedMs: 6 * MIN, medianAnswerMs: 3 * MIN, answers: 2 });
  });

  it('counts a block still going on up to now, but not as an answer', () => {
    log.observe([as('a', 'attention', 'blocked')]);
    clock.advance(5 * MIN);
    expect(log.summary().today).toMatchObject({ blockedMs: 5 * MIN, answers: 0, medianAnswerMs: null });
  });

  it('does not count a guess that a session waits, nor a finished turn, as blocked', () => {
    log.observe([as('a', 'attention', 'maybe-waiting'), as('b', 'attention', 'finished')]);
    clock.advance(10 * MIN);
    log.observe([as('a', 'working'), as('b', 'idle')]);
    expect(log.summary().today).toMatchObject({ blockedMs: 0, answers: 0 });
  });

  it('does not take a block that ended with the session as an answer', () => {
    log.observe([as('a', 'attention', 'blocked')]);
    clock.advance(3 * MIN);
    log.observe([]);
    expect(log.summary().today).toMatchObject({ blockedMs: 3 * MIN, answers: 0 });
  });

  it('averages how many sessions worked at once, over the time any did', () => {
    log.observe([as('a', 'working'), as('b', 'working'), as('c', 'idle')]);
    clock.advance(10 * MIN); // 2 at once for 10 min
    log.observe([as('a', 'working'), as('b', 'idle'), as('c', 'idle')]);
    clock.advance(10 * MIN); // 1 for 10 min
    log.observe([as('a', 'idle'), as('b', 'idle'), as('c', 'idle')]);
    clock.advance(30 * MIN); // none: not counted
    expect(log.summary().today.parallel).toBe(1.5);
  });

  it('leaves shells out', () => {
    log.observe([session('sh', 'running', null, 0, 'shell')]);
    expect(log.summary().timeline.sessions).toEqual([]);
  });

  it('keeps the last hour of each session for the timeline', () => {
    log.observe([as('a', 'working')]);
    clock.advance(70 * MIN);
    log.observe([as('a', 'attention', 'blocked')]);
    clock.advance(5 * MIN);
    const t = log.summary().timeline;
    expect(t.to - t.from).toBe(60 * MIN);
    expect(t.sessions).toEqual([
      {
        id: 'a',
        name: 'A',
        segments: [
          { state: 'working', from: t.from, to: NOON + 70 * MIN },
          { state: 'needs', from: NOON + 70 * MIN, to: null },
        ],
      },
    ]);
  });

  it('forgets a session an hour after it ended', () => {
    log.observe([as('a', 'working')]);
    clock.advance(MIN);
    log.observe([]);
    expect(log.summary().timeline.sessions).toHaveLength(1);
    clock.advance(61 * MIN);
    log.observe([]);
    expect(log.summary().timeline.sessions).toEqual([]);
  });

  it('compares with the average of the previous days, kept across a restart', () => {
    log.observe([as('a', 'attention', 'blocked')]);
    clock.advance(10 * MIN);
    log.observe([as('a', 'working')]);
    log.persist();
    clock.advance(DAY);
    const again = new StatusLog({ now: clock.now, file: join(home.dir(), 'flow.json') });
    const s = again.summary();
    expect(s.today).toMatchObject({ blockedMs: 0, answers: 0 });
    expect(s.previous).toEqual({ blockedMs: 10 * MIN, medianAnswerMs: 10 * MIN });
  });

  it('has nothing to compare with on the first day', () => {
    expect(log.summary().previous).toBeNull();
  });
});
