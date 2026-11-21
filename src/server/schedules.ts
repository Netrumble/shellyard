import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SCHEDULE_PERMISSION_MODES, SCHEDULE_STUCK_AFTER_MS, type Schedule, type ScheduleOutcome, type SchedulePermissionMode, type ScheduleRun, type ScheduleWhen } from '../shared/types.js';
import { nextRun, parseCron, parseTime } from './schedule-time.js';

// Schedules: a prompt given to a new Claude Code session at set times. This file decides
// when a run is due and keeps the record; starting the session is handed in from outside.
//
// They run only while ShellYard is running. What happens to a run missed in the meantime is each
// schedule's own choice (`catchUp`).

export type LaunchResult = { sessionId: string } | { error: string };

export interface ScheduleDeps {
  file: string;
  now: () => number;
  /** Starts the session of a run. It must not throw. */
  launch: (schedule: Schedule) => LaunchResult;
  /** Whether that session is still at work (working, or waiting on a permission). */
  busy: (sessionId: string) => boolean;
  /**
   * The digest of what a launcher runs now (see launcherFingerprint), or null if there is no
   * such launcher. Without it, schedules are not tied to their launcher (tests).
   */
  fingerprint?: (profileId: string) => string | null;
}

/** What a launcher runs, as a digest: kind, command, arguments and environment. */
export function launcherFingerprint(profile: { kind: string; command: string; args: string[]; env: Record<string, string> }): string {
  const env = Object.keys(profile.env)
    .sort()
    .map((k) => [k, profile.env[k]]);
  return createHash('sha256').update(JSON.stringify([profile.kind, profile.command, profile.args, env])).digest('hex');
}

export class ScheduleError extends Error {}

const FILE_VERSION = 1;
const MAX_SCHEDULES = 100;
const MAX_RUNS = 20;
const MAX_PROMPT = 20_000;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
/** A run this late is still the run itself (the tick was slow), not one missed while off. */
const LATE_GRACE_MS = 90_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks a "when" and returns it in its plain form; `now` is given when a new one is set. */
function toWhen(v: unknown, now: number | null): ScheduleWhen {
  if (!isObject(v)) throw new ScheduleError('Say when the schedule runs.');
  switch (v.kind) {
    case 'once': {
      if (typeof v.at !== 'number' || !Number.isFinite(v.at)) throw new ScheduleError('Give the date and time of the run.');
      if (now !== null && v.at <= now) throw new ScheduleError('That date and time are in the past.');
      return { kind: 'once', at: Math.round(v.at) };
    }
    case 'weekly': {
      if (typeof v.time !== 'string' || !parseTime(v.time)) throw new ScheduleError('Give the time as HH:MM, between 00:00 and 23:59.');
      const days = Array.isArray(v.days) ? [...new Set(v.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
      if (days.length === 0) throw new ScheduleError('Choose at least one day of the week.');
      return { kind: 'weekly', time: v.time, days };
    }
    case 'interval': {
      if (!Number.isInteger(v.minutes) || (v.minutes as number) < MIN_INTERVAL_MINUTES || (v.minutes as number) > MAX_INTERVAL_MINUTES) {
        throw new ScheduleError(`An interval is between ${MIN_INTERVAL_MINUTES} minutes and 7 days.`);
      }
      return { kind: 'interval', minutes: v.minutes as number };
    }
    case 'cron': {
      const expr = typeof v.expr === 'string' ? v.expr.trim().replace(/\s+/g, ' ') : '';
      if (expr.length > 200 || !parseCron(expr)) throw new ScheduleError('Not a cron expression. Use five fields: minute, hour, day of month, month, weekday.');
      if (nextRun({ kind: 'cron', expr }, now ?? Date.now()) === null) throw new ScheduleError('That cron expression never comes: no date matches it.');
      return { kind: 'cron', expr };
    }
    default:
      throw new ScheduleError('Say when the schedule runs.');
  }
}

type Fields = Pick<Schedule, 'name' | 'prompt' | 'profileId' | 'model' | 'cwd' | 'storyId' | 'when' | 'enabled' | 'catchUp' | 'permissionMode'>;

/** The fields of a schedule from what a client sent, on top of `base` for what it left out. */
function toFields(input: Record<string, unknown>, base: Fields | null, now: number): Fields {
  const text = (key: 'name' | 'prompt' | 'profileId' | 'cwd', fallback: string): string => {
    const v = input[key];
    if (v === undefined) return base ? base[key] : fallback;
    if (typeof v !== 'string') throw new ScheduleError(`The ${key} must be text.`);
    return key === 'prompt' ? v.replace(/\r\n?/g, '\n').trim() : v.trim();
  };
  const optional = (key: 'model' | 'storyId'): string | null => {
    const v = input[key];
    if (v === undefined) return base ? base[key] : null;
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 200) throw new ScheduleError(`The ${key} is not valid.`);
    return v;
  };
  const flag = (key: 'enabled' | 'catchUp', fallback: boolean): boolean => {
    const v = input[key];
    if (v === undefined) return base ? base[key] : fallback;
    if (typeof v !== 'boolean') throw new ScheduleError(`"${key}" must be true or false.`);
    return v;
  };

  const name = text('name', '');
  if (!name) throw new ScheduleError('Give the schedule a name.');
  if (name.length > 80) throw new ScheduleError('The name is too long (80 characters at most).');
  const prompt = text('prompt', '');
  if (!prompt) throw new ScheduleError('Write the prompt Claude Code is given.');
  if (prompt.length > MAX_PROMPT) throw new ScheduleError(`The prompt is too long (${MAX_PROMPT} characters at most).`);
  const profileId = text('profileId', '');
  if (!profileId || profileId.length > 200) throw new ScheduleError('Choose the Claude Code launcher the session starts from.');
  const cwd = text('cwd', '');
  if (cwd.length > 1024) throw new ScheduleError('The folder path is too long.');

  let permissionMode: SchedulePermissionMode = base?.permissionMode ?? 'default';
  if (input.permissionMode !== undefined) {
    if (!SCHEDULE_PERMISSION_MODES.includes(input.permissionMode as SchedulePermissionMode)) throw new ScheduleError('That permission mode is not offered for scheduled sessions.');
    permissionMode = input.permissionMode as SchedulePermissionMode;
  }

  // A time already set is not checked against the clock again: an old one-off stays valid.
  const when = input.when === undefined && base ? base.when : toWhen(input.when, now);
  return { name, prompt, profileId, model: optional('model'), cwd, storyId: optional('storyId'), when, enabled: flag('enabled', true), catchUp: flag('catchUp', false), permissionMode };
}

const OUTCOMES: ScheduleOutcome[] = ['started', 'delivered', 'undelivered', 'failed', 'skipped'];

/** A run as it is recorded when it starts: nothing known yet of how it went. */
function newRun(at: number, outcome: ScheduleOutcome, detail: string | null, sessionId: string | null, manual: boolean): ScheduleRun {
  return { at, outcome, detail, sessionId, manual, finishedAt: null, closed: false, costUsd: null, blockedMs: 0, blockedSince: null, stuckAt: null };
}

const moment = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function toRun(v: unknown): ScheduleRun | null {
  if (!isObject(v) || typeof v.at !== 'number' || !Number.isFinite(v.at) || !OUTCOMES.includes(v.outcome as ScheduleOutcome)) return null;
  return {
    ...newRun(v.at, v.outcome as ScheduleOutcome, typeof v.detail === 'string' ? v.detail.slice(0, 500) : null, typeof v.sessionId === 'string' ? v.sessionId : null, v.manual === true),
    finishedAt: moment(v.finishedAt),
    closed: v.closed === true,
    costUsd: moment(v.costUsd),
    blockedMs: moment(v.blockedMs) ?? 0,
    blockedSince: moment(v.blockedSince),
    stuckAt: moment(v.stuckAt),
  };
}

/** A run whose session is still followed: it has one, got its prompt or may still, and has not finished. */
const followed = (r: ScheduleRun): boolean => r.sessionId !== null && r.finishedAt === null && (r.outcome === 'started' || r.outcome === 'delivered');

/** How long after its session finished a run still takes the cost Claude Code reports: the last report comes a little late. */
const COST_GRACE_MS = 30_000;

/** What the store needs to know of a session to follow the run it belongs to. */
export interface RunSessionState {
  id: string;
  status: string;
  reason: string | null;
}

function toStored(v: unknown): Schedule | null {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id) return null;
  try {
    const fields = toFields(v, null, 0);
    // toFields checked a "once" against time 0; the file may hold one that has passed.
    return {
      id: v.id,
      ...fields,
      launcher: typeof v.launcher === 'string' && /^[0-9a-f]{64}$/.test(v.launcher) ? v.launcher : null,
      createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : 0,
      nextRunAt: typeof v.nextRunAt === 'number' && Number.isFinite(v.nextRunAt) ? v.nextRunAt : null,
      runs: Array.isArray(v.runs) ? v.runs.map(toRun).filter((r): r is ScheduleRun => r !== null).slice(0, MAX_RUNS) : [],
    };
  } catch {
    return null;
  }
}

const copy = (s: Schedule): Schedule => ({ ...s, when: { ...s.when, ...('days' in s.when ? { days: [...s.when.days] } : {}) } as ScheduleWhen, runs: s.runs.map((r) => ({ ...r })) });

export class ScheduleStore {
  private schedules: Schedule[];
  private readonly changeCbs: Array<(schedules: Schedule[]) => void> = [];

  constructor(private readonly deps: ScheduleDeps) {
    this.schedules = this.load();
  }

  private load(): Schedule[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.deps.file, 'utf8'));
      const list = isObject(raw) ? raw.schedules : null;
      if (!Array.isArray(list)) return [];
      const seen = new Set<string>();
      return list
        .map((item: unknown) => {
          const s = toStored(item);
          // Saved before schedules were tied to their launcher: tied to it as it is now.
          if (s && isObject(item) && !('launcher' in item)) s.launcher = this.deps.fingerprint?.(s.profileId) ?? null;
          return s;
        })
        .filter((s): s is Schedule => s !== null && !seen.has(s.id) && seen.add(s.id) !== undefined)
        .slice(0, MAX_SCHEDULES);
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, schedules: this.schedules }, null, 2), { mode: 0o600 });
      renameSync(tmp, this.deps.file);
    } catch {
      // Not saved this time; the schedules still run, and the next change tries again.
    }
  }

  private changed(): void {
    this.save();
    const list = this.list();
    for (const cb of this.changeCbs) cb(list);
  }

  onChange(cb: (schedules: Schedule[]) => void): void {
    this.changeCbs.push(cb);
  }

  list(): Schedule[] {
    return this.schedules.map(copy);
  }

  create(input: Record<string, unknown>): Schedule {
    if (this.schedules.length >= MAX_SCHEDULES) throw new ScheduleError(`There can be ${MAX_SCHEDULES} schedules at most.`);
    const now = this.deps.now();
    const fields = toFields(input, null, now);
    const schedule: Schedule = { id: randomUUID(), ...fields, launcher: this.launcherOf(fields.profileId), createdAt: now, nextRunAt: fields.enabled ? nextRun(fields.when, now) : null, runs: [] };
    this.schedules.push(schedule);
    this.changed();
    return copy(schedule);
  }

  /** Changes the fields given. Returns null when there is no such schedule. */
  update(id: string, patch: Record<string, unknown>): Schedule | null {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    const now = this.deps.now();
    const fields = toFields(patch, s, now);
    const replan = patch.when !== undefined || fields.enabled !== s.enabled;
    Object.assign(s, fields);
    // Saving the schedule with its launcher named (as its dialog does) is agreeing to that
    // launcher as it is now. Switching it on or off is not.
    if (patch.profileId !== undefined) s.launcher = this.launcherOf(s.profileId);
    if (!s.enabled) s.nextRunAt = null;
    else if (replan || s.nextRunAt === null) s.nextRunAt = nextRun(s.when, now);
    this.changed();
    return copy(s);
  }

  remove(id: string): boolean {
    const before = this.schedules.length;
    this.schedules = this.schedules.filter((s) => s.id !== id);
    if (this.schedules.length === before) return false;
    this.changed();
    return true;
  }

  /** An area was deleted: its schedules stay, and run outside any area. */
  clearStory(storyId: string): void {
    const hit = this.schedules.filter((s) => s.storyId === storyId);
    if (hit.length === 0) return;
    for (const s of hit) s.storyId = null;
    this.changed();
  }

  private record(s: Schedule, run: ScheduleRun): ScheduleRun {
    s.runs = [run, ...s.runs].slice(0, MAX_RUNS);
    return run;
  }

  private launcherOf(profileId: string): string | null {
    return this.deps.fingerprint?.(profileId) ?? null;
  }

  private fire(s: Schedule, manual: boolean): ScheduleRun {
    const at = this.deps.now();
    if (this.deps.fingerprint) {
      const current = this.deps.fingerprint(s.profileId);
      // A launcher that no longer exists is reported by the launch itself.
      if (current !== null && current !== s.launcher) {
        const detail = 'Its launcher was changed since the schedule was saved (command, arguments or environment). Open the schedule and save it again to run it with the launcher as it is now.';
        return this.record(s, newRun(at, 'failed', detail, null, manual));
      }
    }
    const previous = s.runs.find((r) => r.sessionId !== null);
    if (!manual && previous?.sessionId && this.deps.busy(previous.sessionId)) {
      return this.record(s, newRun(at, 'skipped', 'The session of the previous run was still at work.', null, manual));
    }
    let result: LaunchResult;
    try {
      result = this.deps.launch(copy(s));
    } catch (e) {
      result = { error: (e as Error).message };
    }
    if ('error' in result) return this.record(s, newRun(at, 'failed', result.error.slice(0, 500), null, manual));
    return this.record(s, newRun(at, 'started', null, result.sessionId, manual));
  }

  /** Sets what became of the prompt of the run that opened `sessionId`. */
  resolveRun(id: string, sessionId: string, outcome: ScheduleOutcome, detail: string | null): void {
    const run = this.schedules.find((s) => s.id === id)?.runs.find((r) => r.sessionId === sessionId);
    if (!run || run.outcome !== 'started') return;
    run.outcome = outcome;
    run.detail = detail;
    this.changed();
  }

  /** The run that opened a session, if any. */
  private runOf(sessionId: string): ScheduleRun | null {
    for (const s of this.schedules) {
      const run = s.runs.find((r) => r.sessionId === sessionId);
      if (run) return run;
    }
    return null;
  }

  /**
   * Follows the sessions of the runs in progress: when they wait on the user and for how long,
   * and when they finish their turn after the prompt (or end). Called with every change of the
   * sessions; saves only when something about a run changed.
   */
  observe(sessions: RunSessionState[]): void {
    const now = this.deps.now();
    const byId = new Map(sessions.map((x) => [x.id, x]));
    let any = false;
    for (const s of this.schedules) {
      for (const run of s.runs) {
        if (!followed(run)) continue;
        const session = byId.get(run.sessionId!);
        const ended = !session || session.status === 'exited';
        const blocked = !ended && session.status === 'attention' && session.reason === 'blocked';
        if (blocked && run.blockedSince === null) {
          run.blockedSince = now;
          any = true;
        } else if (!blocked && run.blockedSince !== null) {
          run.blockedMs += Math.max(0, now - run.blockedSince);
          run.blockedSince = null;
          any = true;
        }
        // Its turn is over once the prompt was given and Claude Code waits for the next one.
        const done = run.outcome === 'delivered' && session !== undefined && (session.status === 'idle' || (session.status === 'attention' && session.reason === 'finished'));
        if (ended || done) {
          run.finishedAt = now;
          run.closed = !done;
          any = true;
        }
      }
    }
    if (any) this.changed();
  }

  /**
   * Takes the cost Claude Code reports for a session, for the run that opened it: until it
   * finishes, and a little after. Kept without saving, as reports come every few seconds; it is
   * saved with the next change of the run.
   */
  observeCost(sessionId: string, costUsd: number | null): void {
    if (costUsd === null || !Number.isFinite(costUsd) || costUsd < 0) return;
    const run = this.runOf(sessionId);
    if (!run || run.sessionId === null) return;
    if (run.finishedAt !== null && this.deps.now() - run.finishedAt > COST_GRACE_MS) return;
    run.costUsd = costUsd;
  }

  /** Runs a schedule now, whether or not it is enabled; its own timetable is not moved. */
  runNow(id: string): ScheduleRun | null {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return null;
    const run = { ...this.fire(s, true) };
    this.changed();
    return run;
  }

  /**
   * Called once when ShellYard starts: settles the runs whose time passed while it was not running.
   * A schedule that catches up is left due, and runs at the first tick; another has the
   * miss recorded and waits for its next time.
   */
  start(): void {
    const now = this.deps.now();
    let any = false;
    for (const s of this.schedules) {
      if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now - LATE_GRACE_MS || s.catchUp) continue;
      this.record(s, newRun(now, 'skipped', `ShellYard was not running at the time of this run (${new Date(s.nextRunAt).toLocaleString('en-GB')}).`, null, false));
      this.plan(s, now);
      any = true;
    }
    if (any) this.changed();
  }

  private plan(s: Schedule, now: number): void {
    s.nextRunAt = nextRun(s.when, now);
    // A one-off has had its turn.
    if (s.nextRunAt === null) s.enabled = false;
  }

  /** Starts whatever is due, and reports runs that wait on the user too long. Called every second. */
  tick(): void {
    const now = this.deps.now();
    let any = false;
    for (const s of this.schedules) {
      for (const run of s.runs) {
        if (followed(run) && run.blockedSince !== null && run.stuckAt === null && now - run.blockedSince >= SCHEDULE_STUCK_AFTER_MS) {
          run.stuckAt = now;
          any = true;
        }
      }
    }
    for (const s of this.schedules) {
      if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now) continue;
      this.fire(s, false);
      this.plan(s, now);
      any = true;
    }
    if (any) this.changed();
  }
}
