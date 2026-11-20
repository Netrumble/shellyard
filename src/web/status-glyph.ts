import type { SessionInfo } from '../shared/types.js';
import { revLevel } from './gauges.js';

/**
 * The shape that tells a session's state, readable before its colour: a diamond waits for you
 * (hollow when that is only a guess), a ring is working, a disc has finished, an empty circle
 * is idle, a square has ended.
 */
export type Glyph = 'needs' | 'maybe' | 'working' | 'finished' | 'idle' | 'exited';

/**
 * `rate` is what the terminal printed in the last second. A shell is always "running", so it
 * counts as working only while it prints; a Claude session reports its own state.
 */
export function glyphOf(s: SessionInfo, rate = 0): Glyph {
  if (s.status === 'exited') return 'exited';
  if (s.status === 'attention') {
    if (s.reason === 'finished') return 'finished';
    if (s.reason === 'maybe-waiting') return 'maybe';
    return 'needs';
  }
  if (s.status === 'working') return 'working';
  if (s.status === 'running') return rate > 0 ? 'working' : 'idle';
  return 'idle';
}

const LABELS: Record<Glyph, string> = {
  needs: 'Needs you',
  maybe: 'Possibly waiting',
  working: 'Working',
  finished: 'Finished',
  idle: 'Idle',
  exited: 'Exited',
};

export function glyphLabel(g: Glyph): string {
  return LABELS[g];
}

const SLOWEST_S = 2.4;
const FASTEST_S = 0.6;

/** Seconds per turn of the working ring: faster when busy, null (no turning) when quiet. */
export function spinSeconds(bytesPerSecond: number): number | null {
  const level = revLevel(bytesPerSecond);
  if (!(level > 0)) return null;
  return Math.round((SLOWEST_S - level * (SLOWEST_S - FASTEST_S)) * 100) / 100;
}
