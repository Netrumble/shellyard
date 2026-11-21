import type { Schedule, ScheduleOutcome, ScheduleRun, ScheduleWhen } from '../shared/types.js';
import { durationLabel } from './gauges.js';

// What a schedule says in words, and the conversions its form needs.

/** Weekdays in the order a week is read, Monday first; the numbers are Date's (0 is Sunday). */
export const WEEK: Array<{ day: number; short: string }> = [
  { day: 1, short: 'Mon' },
  { day: 2, short: 'Tue' },
  { day: 3, short: 'Wed' },
  { day: 4, short: 'Thu' },
  { day: 5, short: 'Fri' },
  { day: 6, short: 'Sat' },
  { day: 0, short: 'Sun' },
];

const plural = (n: number, unit: string): string => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);

export function whenLabel(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function describeWhen(when: ScheduleWhen): string {
  switch (when.kind) {
    case 'once':
      return `Once, ${whenLabel(when.at)}`;
    case 'weekly': {
      const has = (d: number): boolean => when.days.includes(d);
      if (when.days.length === 7) return `Every day at ${when.time}`;
      if (when.days.length === 5 && [1, 2, 3, 4, 5].every(has)) return `Weekdays at ${when.time}`;
      return `${WEEK.filter((w) => has(w.day)).map((w) => w.short).join(', ')} at ${when.time}`;
    }
    case 'interval':
      if (when.minutes % 1440 === 0) return plural(when.minutes / 1440, 'day');
      if (when.minutes % 60 === 0) return plural(when.minutes / 60, 'hour');
      return plural(when.minutes, 'minute');
    case 'cron':
      return `Cron: ${when.expr}`;
  }
}

export function outcomeText(outcome: ScheduleOutcome): string {
  switch (outcome) {
    case 'started':
      return 'Started, prompt on its way';
    case 'delivered':
      return 'Prompt given';
    case 'undelivered':
      return 'Session open, prompt not given';
    case 'failed':
      return 'Could not start';
    case 'skipped':
      return 'Skipped';
  }
}

/** An estimated cost in dollars: cents below ten dollars, whole dollars above. */
export function costLabel(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}

/**
 * How a run went beyond its prompt, in a few words, and whether it needs the user: "Done in 4m ·
 * $0.42", "Waiting on you for 12m", "Working for 3m". Empty when there is nothing to add (a run
 * that failed, was skipped, or whose prompt was not given).
 */
export function runResult(run: ScheduleRun, now: number): { text: string; tone: string; needsYou: boolean } {
  const cost = run.costUsd !== null && run.costUsd > 0 ? costLabel(run.costUsd) : null;
  // A permission answered at once is not worth a mention.
  const waited = run.blockedMs >= 1000 ? `waited on you ${spanLabel(run.blockedMs)}` : null;
  const join = (...parts: Array<string | null>): string => parts.filter(Boolean).join(' · ');
  const none = { text: '', tone: '', needsYou: false };
  // A run that never had a session at work (or whose prompt was not given) has nothing to add.
  if (run.sessionId === null || (run.outcome !== 'started' && run.outcome !== 'delivered')) return none;
  const took = run.finishedAt !== null ? spanLabel(run.finishedAt - run.at) : '';
  switch (run.endedBy) {
    case 'turn':
      return { text: join(`Done in ${took}`, cost, waited), tone: 'tone-ok', needsYou: false };
    case 'session':
      return { text: join(`Ended after ${took}, before finishing`, cost, waited), tone: 'tone-muted', needsYou: false };
    case 'restart':
      return { text: join('Stopped with ShellYard, before finishing', cost, waited), tone: 'tone-muted', needsYou: false };
    case 'unknown':
      return none;
  }
  if (run.blockedSince !== null) {
    const text = join(`Waiting on you for ${spanLabel(now - run.blockedSince)}`, cost);
    return { text, tone: run.stuckAt !== null ? 'tone-dead' : 'tone-warn', needsYou: true };
  }
  return { text: join(`Working for ${spanLabel(now - run.at)}`, cost, waited), tone: 'tone-done', needsYou: false };
}

/**
 * A span of time in words, "under 1s" for less than a second (where durationLabel says "now").
 * A span from the server's clock to the browser's may come out negative when they disagree: it is
 * then the shortest.
 */
export function spanLabel(ms: number): string {
  return ms < 1000 ? 'under 1s' : durationLabel(ms);
}

/** The runs that have just been found waiting on the user too long, with their schedule. */
export function newlyStuck(prev: Schedule[], next: Schedule[]): Array<{ schedule: Schedule; run: ScheduleRun }> {
  const before = new Set(prev.flatMap((s) => s.runs.filter((r) => r.stuckAt !== null).map((r) => `${s.id}@${r.at}`)));
  const out: Array<{ schedule: Schedule; run: ScheduleRun }> = [];
  for (const s of next) for (const r of s.runs) if (r.stuckAt !== null && r.blockedSince !== null && !before.has(`${s.id}@${r.at}`)) out.push({ schedule: s, run: r });
  return out;
}

/** The colour class of an outcome, from the ones the rest of the page uses. */
export function outcomeTone(outcome: ScheduleOutcome): string {
  return outcome === 'delivered' ? 'tone-ok' : outcome === 'started' ? 'tone-done' : outcome === 'skipped' ? 'tone-muted' : outcome === 'failed' ? 'tone-dead' : 'tone-warn';
}

const two = (n: number): string => String(n).padStart(2, '0');

/** A moment as the value of a datetime-local field, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0).getTime();
  return Number.isFinite(t) ? t : null;
}
