import type { SessionInfo, Story } from '../shared/types.js';
import { groupByStory } from './selectors.js';
import { glyphOf, type Glyph } from './status-glyph.js';

/**
 * How much an area calls for the user: 0 someone waits on them, 1 something works, 2 something
 * finished, 3 quiet. A shell that merely runs is quiet: its output comes and goes by the second,
 * and areas jumping about with it would be impossible to aim at.
 */
function activityTier(sessions: SessionInfo[]): number {
  let tier = 3;
  for (const s of sessions) {
    if (s.status === 'attention' && s.reason !== 'finished') return 0;
    if (s.status === 'working') tier = Math.min(tier, 1);
    else if (s.status === 'attention') tier = Math.min(tier, 2);
  }
  return tier;
}

/**
 * The areas with the busiest first, in the user's order within each level. The area for the
 * sessions with no area stays last: it is where a session is dropped to take it out of one.
 */
export function byActivity(areas: BoardArea[]): BoardArea[] {
  const named = areas.filter((a) => a.story !== null);
  const loose = areas.filter((a) => a.story === null);
  const tiers = new Map(named.map((a) => [a, activityTier(a.sessions)]));
  return [...[...named].sort((x, y) => tiers.get(x)! - tiers.get(y)!), ...loose];
}

export type GlyphCounts = Record<Exclude<Glyph, 'maybe'>, number>;

/** The sessions of an area by glyph; a guess that one waits counts as waiting. */
export function glyphCounts(sessions: SessionInfo[], rates: Record<string, number>): GlyphCounts {
  const counts: GlyphCounts = { needs: 0, working: 0, finished: 0, idle: 0, exited: 0 };
  for (const s of sessions) {
    const g = glyphOf(s, rates[s.id] ?? 0);
    counts[g === 'maybe' ? 'needs' : g]++;
  }
  return counts;
}

/** The branch most of the sessions of an area are on; null when none of them knows. */
export function areaBranch(sessions: SessionInfo[]): string | null {
  const tally = new Map<string, number>();
  for (const s of sessions) {
    const b = s.git?.branch;
    if (b) tally.set(b, (tally.get(b) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [b, n] of tally) if (best === null || n > tally.get(best)!) best = b;
  return best;
}

/** What an area as a whole is doing: someone waiting beats working, working beats quiet. */
export type AreaState = 'attention' | 'working' | 'quiet';

export interface BoardArea {
  /** Null for the sessions that belong to no area. */
  story: Story | null;
  sessions: SessionInfo[];
  state: AreaState;
}

function stateOf(sessions: SessionInfo[]): AreaState {
  if (sessions.some((s) => s.status === 'attention')) return 'attention';
  if (sessions.some((s) => s.status === 'working' || s.status === 'running')) return 'working';
  return 'quiet';
}

/**
 * The areas of the board, in the order of the stories (which the user arranges). The
 * sessions that belong to no area come last; that place is always offered
 * once areas exist, so that a session can be dragged out of an area.
 */
export function boardAreas(sessions: SessionInfo[], stories: Story[]): BoardArea[] {
  const groups = groupByStory(sessions, stories);
  const named = groups.filter((g) => g.story !== null).map((g) => ({ story: g.story, sessions: g.sessions, state: stateOf(g.sessions) }));
  const loose = groups.find((g) => g.story === null)?.sessions ?? [];
  if (stories.length === 0 && loose.length === 0) return [];
  return [...named, { story: null, sessions: loose, state: stateOf(loose) }];
}

/** One line on what the sessions of an area are doing, most pressing first. */
export function areaSummary(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return 'No sessions';
  const count = (test: (s: SessionInfo) => boolean): number => sessions.filter(test).length;
  const need = count((s) => s.status === 'attention' && s.reason !== 'finished');
  const parts: Array<[number, string]> = [
    [need, need === 1 ? 'needs you' : 'need you'],
    [count((s) => s.status === 'attention' && s.reason === 'finished'), 'finished'],
    [count((s) => s.status === 'working' || s.status === 'running'), 'working'],
    [count((s) => s.status === 'idle'), 'idle'],
    [count((s) => s.status === 'exited'), 'exited'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ');
}
