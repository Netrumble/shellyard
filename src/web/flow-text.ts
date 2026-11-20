import type { FlowSegment, FlowState } from '../shared/types.js';

/** "27 min", "1 h 35 min". */
export function blockedTime(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** "2m 10s", "45s"; a dash when there was no answer. */
export function answerTime(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`.replace(/m 0(\d)s$/, 'm $1s');
}

export interface Comparison {
  text: string;
  /** Less waiting is better. */
  better: boolean;
}

/** Today against the days before, in percent: "−35% vs last week". */
export function compareBlocked(today: number, before: number | null): Comparison | null {
  if (before === null || before <= 0) return null;
  const pct = Math.round(((today - before) / before) * 100);
  return { text: `${pct <= 0 ? '−' : '+'}${Math.abs(pct)}% vs last week`, better: pct <= 0 };
}

/** Today's median answer against the days before: "−48 s vs last week". */
export function compareAnswer(today: number | null, before: number | null): Comparison | null {
  if (today === null || before === null) return null;
  const diff = today - before;
  const size = Math.abs(diff) < 60_000 ? `${Math.round(Math.abs(diff) / 1000)} s` : answerTime(Math.abs(diff));
  return { text: `${diff <= 0 ? '−' : '+'}${size} vs last week`, better: diff <= 0 };
}

export interface Bar {
  state: FlowState;
  /** Percent of the window. */
  left: number;
  width: number;
}

/** Segments under 0.5% of the window are not drawn: they would be a hairline nobody can see. */
const MIN_WIDTH = 0.5;

/** The segments of a session as bars across the window, an open one running to its end. */
export function timelineBars(segments: FlowSegment[], from: number, to: number): Bar[] {
  const span = to - from;
  if (span <= 0) return [];
  const pct = (ms: number): number => Math.round(((ms - from) / span) * 10_000) / 100;
  const bars: Bar[] = [];
  for (const s of segments) {
    const start = Math.max(s.from, from);
    const end = Math.min(s.to ?? to, to);
    if (end <= start) continue;
    const left = pct(start);
    const width = Math.round((pct(end) - left) * 100) / 100;
    if (width >= MIN_WIDTH) bars.push({ state: s.state, left, width });
  }
  return bars;
}

const WORDS: Record<FlowState, string> = {
  needs: 'waiting for you',
  maybe: 'possibly waiting',
  working: 'working',
  finished: 'finished',
  idle: 'idle',
};

/** The bar of a session in words, for those who cannot see it: time per state, most first. */
export function timelineSummary(segments: FlowSegment[], from: number, to: number): string {
  const total = new Map<FlowState, number>();
  for (const s of segments) {
    const ms = Math.min(s.to ?? to, to) - Math.max(s.from, from);
    if (ms > 0) total.set(s.state, (total.get(s.state) ?? 0) + ms);
  }
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, ms]) => ms >= 60_000)
    .map(([state, ms]) => `${WORDS[state]} ${blockedTime(ms)}`)
    .join(', ');
}
