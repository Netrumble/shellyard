import { describe, expect, it } from 'vitest';
import { describeWhen, fromLocalInput, outcomeText, toLocalInput } from '../../src/web/schedule-text.js';

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
