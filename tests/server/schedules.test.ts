import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Schedule } from '../../src/shared/types.js';
import { launcherFingerprint, ScheduleError, ScheduleStore, type LaunchResult } from '../../src/server/schedules.js';
import { useTempHome } from '../helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('ScheduleStore', () => {
  const home = useTempHome();
  let now = 0;
  let launches: Schedule[] = [];
  let launchResult: (s: Schedule) => LaunchResult = () => ({ sessionId: 'session-1' });
  let busy = new Set<string>();

  const make = (): ScheduleStore => {
    return new ScheduleStore({
      file: join(home.dir(), 'schedules.json'),
      now: () => now,
      launch: (s) => {
        launches.push(s);
        return launchResult(s);
      },
      busy: (sessionId) => busy.has(sessionId),
    });
  };
  const fresh = (): ScheduleStore => {
    now = new Date(2026, 10, 17, 10, 0).getTime();
    launches = [];
    launchResult = () => ({ sessionId: `session-${launches.length}` });
    busy = new Set();
    return make();
  };
  const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Morning review',
    prompt: 'Review the open pull requests.',
    profileId: 'builtin-claude',
    when: { kind: 'interval', minutes: 60 },
    ...over,
  });

  it('creates a schedule with sensible defaults and says when it runs next', () => {
    const store = fresh();
    const s = store.create(input());
    expect(s).toMatchObject({ name: 'Morning review', prompt: 'Review the open pull requests.', profileId: 'builtin-claude', model: null, cwd: '', storyId: null, enabled: true, catchUp: false, permissionMode: 'default', runs: [] });
    expect(s.nextRunAt).toBe(now + HOUR);
    expect(store.list()).toEqual([s]);
  });

  it('refuses a schedule that could not run', () => {
    const store = fresh();
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: '  ' }, /name/i],
      [{ prompt: '' }, /prompt/i],
      [{ profileId: '' }, /launcher/i],
      [{ when: { kind: 'interval', minutes: 1 } }, /5 minutes/],
      [{ when: { kind: 'weekly', time: '25:00', days: [1] } }, /time/i],
      [{ when: { kind: 'weekly', time: '08:00', days: [] } }, /day/i],
      [{ when: { kind: 'cron', expr: '61 * * * *' } }, /cron/i],
      [{ when: { kind: 'cron', expr: '0 0 31 2 *' } }, /never/i],
      [{ when: { kind: 'once', at: now - 1 } }, /past/i],
      [{ when: { kind: 'sometimes' } }, /when/i],
      [{ permissionMode: 'bypassPermissions' }, /permission/i],
    ];
    for (const [over, message] of bad) expect(() => store.create(input(over)), JSON.stringify(over)).toThrow(message);
    expect(() => store.create(input({ name: '' }))).toThrow(ScheduleError);
    expect(store.list()).toEqual([]);
  });

  it('starts a session when the time comes, records it, and plans the next run', () => {
    const store = fresh();
    const s = store.create(input());
    now += HOUR - 1;
    store.tick();
    expect(launches).toEqual([]);
    now += 1;
    store.tick();
    expect(launches.map((l) => l.id)).toEqual([s.id]);
    const after = store.list()[0]!;
    expect(after.runs).toEqual([{ at: now, outcome: 'started', detail: null, sessionId: 'session-1', manual: false }]);
    expect(after.nextRunAt).toBe(now + HOUR);
    store.tick();
    expect(launches).toHaveLength(1);
  });

  it('records how the prompt fared once that is known', () => {
    const store = fresh();
    const s = store.create(input());
    now += HOUR;
    store.tick();
    store.resolveRun(s.id, 'session-1', 'delivered', null);
    expect(store.list()[0]!.runs[0]).toMatchObject({ outcome: 'delivered', sessionId: 'session-1' });
    store.resolveRun(s.id, 'session-unknown', 'undelivered', 'x');
    expect(store.list()[0]!.runs[0]).toMatchObject({ outcome: 'delivered' });
  });

  it('records a run that could not start, and still plans the next one', () => {
    const store = fresh();
    store.create(input());
    launchResult = () => ({ error: 'Launcher not found: builtin-claude' });
    now += HOUR;
    store.tick();
    expect(store.list()[0]!.runs[0]).toMatchObject({ outcome: 'failed', detail: 'Launcher not found: builtin-claude', sessionId: null });
    expect(store.list()[0]!.nextRunAt).toBe(now + HOUR);
  });

  it('skips a run while the session of the previous one is still at work', () => {
    const store = fresh();
    store.create(input());
    now += HOUR;
    store.tick();
    busy.add('session-1');
    now += HOUR;
    store.tick();
    expect(launches).toHaveLength(1);
    expect(store.list()[0]!.runs[0]).toMatchObject({ outcome: 'skipped', detail: 'The session of the previous run was still at work.' });
    busy.clear();
    now += HOUR;
    store.tick();
    expect(launches).toHaveLength(2);
  });

  it('runs a one-off once and then switches it off', () => {
    const store = fresh();
    store.create(input({ when: { kind: 'once', at: now + 10 * MIN } }));
    now += 10 * MIN;
    store.tick();
    expect(launches).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('leaves a paused schedule alone, and plans it afresh when resumed', () => {
    const store = fresh();
    const s = store.create(input());
    expect(store.update(s.id, { enabled: false })).toMatchObject({ enabled: false, nextRunAt: null });
    now += 3 * HOUR;
    store.tick();
    expect(launches).toEqual([]);
    expect(store.update(s.id, { enabled: true })!.nextRunAt).toBe(now + HOUR);
  });

  it('changes a schedule, checking the result as a whole', () => {
    const store = fresh();
    const s = store.create(input());
    const changed = store.update(s.id, { name: 'Evening review', when: { kind: 'weekly', time: '18:00', days: [1, 3] }, storyId: 'area-1', cwd: 'C:\\work', model: 'opus', catchUp: true, permissionMode: 'plan' })!;
    expect(changed).toMatchObject({ name: 'Evening review', storyId: 'area-1', cwd: 'C:\\work', model: 'opus', catchUp: true, permissionMode: 'plan' });
    // 17 November 2026 is a Tuesday: the next of Monday/Wednesday at 18:00 is the 18th.
    expect(changed.nextRunAt).toBe(new Date(2026, 10, 18, 18, 0).getTime());
    expect(() => store.update(s.id, { prompt: ' ' })).toThrow(/prompt/i);
    expect(store.list()[0]!.name).toBe('Evening review');
    expect(store.update('nope', { name: 'x' })).toBeNull();
  });

  it('runs a schedule at once on request, without moving its next run', () => {
    const store = fresh();
    const s = store.create(input());
    const next = s.nextRunAt;
    now += 5 * MIN;
    expect(store.runNow(s.id)).toMatchObject({ outcome: 'started', manual: true });
    expect(store.list()[0]!.nextRunAt).toBe(next);
    expect(store.runNow('nope')).toBeNull();
    // A paused schedule can still be run by hand.
    store.update(s.id, { enabled: false });
    expect(store.runNow(s.id)).toMatchObject({ outcome: 'started' });
    expect(launches).toHaveLength(2);
  });

  it('keeps the last twenty runs', () => {
    const store = fresh();
    const s = store.create(input({ when: { kind: 'interval', minutes: 5 } }));
    for (let i = 0; i < 25; i++) {
      now += 5 * MIN;
      store.tick();
    }
    const runs = store.list()[0]!.runs;
    expect(runs).toHaveLength(20);
    expect(runs[0]!.at).toBe(now);
    expect(s.id).toBe(store.list()[0]!.id);
  });

  it('removes a schedule', () => {
    const store = fresh();
    const s = store.create(input());
    expect(store.remove(s.id)).toBe(true);
    expect(store.remove(s.id)).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('forgets the area of a schedule when the area is deleted', () => {
    const store = fresh();
    const s = store.create(input({ storyId: 'area-1' }));
    store.clearStory('area-1');
    expect(store.list()[0]).toMatchObject({ id: s.id, storyId: null });
  });

  it('tells its listeners about every change', () => {
    const store = fresh();
    const seen: number[] = [];
    store.onChange((list) => seen.push(list.length));
    const s = store.create(input());
    store.update(s.id, { name: 'x' });
    store.remove(s.id);
    expect(seen).toEqual([1, 1, 0]);
  });

  describe('across a restart', () => {
    it('keeps schedules and their history', () => {
      const store = fresh();
      const s = store.create(input());
      now += HOUR;
      store.tick();
      const again = make();
      expect(again.list()).toEqual(store.list());
      expect(again.list()[0]!.id).toBe(s.id);
    });

    it('records a run missed while ShellYard was off as skipped, and waits for the next one', () => {
      const store = fresh();
      store.create(input());
      const missed = now + HOUR;
      now += 5 * HOUR;
      const again = make();
      again.start();
      again.tick();
      expect(launches).toEqual([]);
      expect(again.list()[0]!.runs[0]).toMatchObject({ at: now, outcome: 'skipped', sessionId: null });
      expect(again.list()[0]!.runs[0]!.detail).toMatch(/ShellYard was not running/);
      expect(again.list()[0]!.nextRunAt).toBe(now + HOUR);
      expect(missed).toBeLessThan(now);
    });

    it('runs a missed run once at start when the schedule asks to catch up', () => {
      const store = fresh();
      store.create(input({ catchUp: true }));
      now += 5 * HOUR;
      const again = make();
      again.start();
      again.tick();
      expect(launches).toHaveLength(1);
      expect(again.list()[0]!.nextRunAt).toBe(now + HOUR);
      again.tick();
      expect(launches).toHaveLength(1);
    });

    it('switches off a one-off whose time passed while ShellYard was off', () => {
      const store = fresh();
      store.create(input({ when: { kind: 'once', at: now + HOUR } }));
      now += 5 * HOUR;
      const again = make();
      again.start();
      again.tick();
      expect(launches).toEqual([]);
      expect(again.list()[0]).toMatchObject({ enabled: false, nextRunAt: null });
      expect(again.list()[0]!.runs[0]).toMatchObject({ outcome: 'skipped' });
    });

    it('starts empty from a file it cannot read, and does not overwrite it until something changes', () => {
      fresh();
      const file = join(home.dir(), 'schedules.json');
      writeFileSync(file, '{ not json');
      const store = make();
      expect(store.list()).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe('{ not json');
      store.create(input());
      expect(JSON.parse(readFileSync(file, 'utf8')).schedules).toHaveLength(1);
      expect(existsSync(file)).toBe(true);
    });

    it('drops entries of the file that are not schedules', () => {
      const store = fresh();
      const s = store.create(input());
      const file = join(home.dir(), 'schedules.json');
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      raw.schedules.push({ id: 'x' }, null, { ...raw.schedules[0], id: 'y', when: { kind: 'cron', expr: 'bad' } });
      writeFileSync(file, JSON.stringify(raw));
      expect(make().list().map((x) => x.id)).toEqual([s.id]);
    });
  });
});

describe('a schedule tied to its launcher', () => {
  const home = useTempHome();
  let now = new Date(2026, 10, 17, 10, 0).getTime();
  let launches: Schedule[] = [];
  const profiles = new Map<string, { kind: string; command: string; args: string[]; env: Record<string, string> }>();

  const make = (): ScheduleStore =>
    new ScheduleStore({
      file: join(home.dir(), 'schedules.json'),
      now: () => now,
      launch: (s) => {
        launches.push(s);
        return { sessionId: `session-${launches.length}` };
      },
      busy: () => false,
      fingerprint: (id) => {
        const p = profiles.get(id);
        return p ? launcherFingerprint(p) : null;
      },
    });
  const input = { name: 'Nightly', prompt: 'Run the checks.', profileId: 'mine', when: { kind: 'interval', minutes: 60 } };
  const reset = (): void => {
    now = new Date(2026, 10, 17, 10, 0).getTime();
    launches = [];
    profiles.clear();
    profiles.set('mine', { kind: 'claude', command: 'claude', args: [], env: {} });
  };

  it('runs while the launcher is the one it was saved with', () => {
    reset();
    const store = make();
    const s = store.create(input);
    expect(s.launcher).toMatch(/^[0-9a-f]{64}$/);
    expect(store.runNow(s.id)!.outcome).toBe('started');
  });

  it('refuses to run, timetable or by hand, once the launcher runs something else', () => {
    reset();
    const store = make();
    const s = store.create(input);
    profiles.set('mine', { kind: 'claude', command: 'C:\other\tool.exe', args: [], env: {} });
    const run = store.runNow(s.id)!;
    expect(run.outcome).toBe('failed');
    expect(run.detail).toMatch(/launcher was changed/);
    now += 61 * MIN;
    store.tick();
    expect(store.list()[0]!.runs[0]!.outcome).toBe('failed');
    expect(launches).toHaveLength(0);
  });

  it('notices changed arguments and environment too, but not the order of the variables', () => {
    reset();
    profiles.set('mine', { kind: 'claude', command: 'claude', args: [], env: { A: '1', B: '2' } });
    const store = make();
    const s = store.create(input);
    profiles.set('mine', { kind: 'claude', command: 'claude', args: [], env: { B: '2', A: '1' } });
    expect(store.runNow(s.id)!.outcome).toBe('started');
    profiles.set('mine', { kind: 'claude', command: 'claude', args: ['--dangerously-skip-permissions'], env: { A: '1', B: '2' } });
    expect(store.runNow(s.id)!.outcome).toBe('failed');
  });

  it('is tied to the launcher as it is now when saved again from its dialog, not when switched on or off', () => {
    reset();
    const store = make();
    const s = store.create(input);
    profiles.set('mine', { kind: 'claude', command: 'claude', args: ['--verbose'], env: {} });
    store.update(s.id, { enabled: false });
    store.update(s.id, { enabled: true });
    expect(store.runNow(s.id)!.outcome).toBe('failed');
    store.update(s.id, { ...input });
    expect(store.runNow(s.id)!.outcome).toBe('started');
  });

  it('ties a schedule saved before this check to its launcher as it is at load', () => {
    reset();
    const s = make().create(input);
    const file = join(home.dir(), 'schedules.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.schedules[0].launcher;
    writeFileSync(file, JSON.stringify(raw));
    profiles.set('mine', { kind: 'claude', command: 'claude', args: ['--verbose'], env: {} });
    const store = make();
    expect(store.list()[0]!.launcher).toBe(launcherFingerprint(profiles.get('mine')!));
    expect(store.runNow(s.id)!.outcome).toBe('started');
  });
});
