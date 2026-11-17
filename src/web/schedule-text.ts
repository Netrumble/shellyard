import type { ScheduleOutcome, ScheduleWhen } from '../shared/types.js';

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
