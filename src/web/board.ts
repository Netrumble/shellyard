import type { SessionInfo, Story } from '../shared/types.js';
import { groupByStory } from './selectors.js';

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
