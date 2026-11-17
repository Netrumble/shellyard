import type { ScheduleWhen } from '../shared/types.js';

// When a schedule runs next. All of it is in the local time of this machine: "every day at
// 08:30" means 08:30 on the clock of whoever wrote it.

export interface Cron {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  /** 0 is Sunday. */
  weekdays: number[];
  /** True when the field was "*": the day rule then rests on the other field alone. */
  anyDay: boolean;
  anyWeekday: boolean;
}

/** How far ahead a next run is looked for; a date that only exists in leap years is within it. */
const HORIZON_DAYS = 366 * 8 + 2;

function field(text: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let from = min;
    let to = max;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number) as [number, number | undefined];
      from = a;
      // "5/15" means from 5 to the end in steps; a plain "5" is just 5.
      to = b ?? (m[2] === undefined ? a : max);
    }
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = field(parts[0]!, 0, 59);
  const hours = field(parts[1]!, 0, 23);
  const days = field(parts[2]!, 1, 31);
  const months = field(parts[3]!, 1, 12);
  const rawWeekdays = field(parts[4]!, 0, 7);
  if (!minutes || !hours || !days || !months || !rawWeekdays) return null;
  const weekdays = [...new Set(rawWeekdays.map((d) => d % 7))].sort((a, b) => a - b);
  return { minutes, hours, days, months, weekdays, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' };
}

/** The first moment after `after` on a day that `dayOk` accepts, at one of the given times. */
function nextOnDays(after: number, dayOk: (d: Date) => boolean, hours: number[], minutes: number[]): number | null {
  const start = new Date(after);
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (!dayOk(day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        // A time the clocks skip that day (the hour lost to summer time) does not happen.
        if (t.getHours() !== h || t.getMinutes() !== m) continue;
        if (t.getTime() > after) return t.getTime();
      }
    }
  }
  return null;
}

export function parseTime(time: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** The next run strictly after `after`, or null when there is none. */
export function nextRun(when: ScheduleWhen, after: number): number | null {
  switch (when.kind) {
    case 'once':
      return when.at > after ? when.at : null;
    case 'interval':
      return after + when.minutes * 60_000;
    case 'weekly': {
      const time = parseTime(when.time);
      if (!time || when.days.length === 0) return null;
      return nextOnDays(after, (d) => when.days.includes(d.getDay()), [time.hour], [time.minute]);
    }
    case 'cron': {
      const c = parseCron(when.expr);
      if (!c) return null;
      const dayOk = (d: Date): boolean => {
        if (!c.months.includes(d.getMonth() + 1)) return false;
        const onDay = c.days.includes(d.getDate());
        const onWeekday = c.weekdays.includes(d.getDay());
        // As cron does it: with both fields set, either one is enough.
        if (!c.anyDay && !c.anyWeekday) return onDay || onWeekday;
        return onDay && onWeekday;
      };
      return nextOnDays(after, dayOk, c.hours, c.minutes);
    }
  }
}
