import type { SessionInfo, Story } from '../shared/types.js';

/** Sessions that cannot continue without the user come before those that merely finished. */
function attentionRank(s: SessionInfo): number {
  return s.reason === 'finished' ? 1 : 0;
}

/** Sessions waiting for the user: blocked ones first, then finished ones, oldest wait first. */
export function selectAttention(sessions: SessionInfo[]): SessionInfo[] {
  return sessions
    .filter((s) => s.status === 'attention')
    .sort((a, b) => attentionRank(a) - attentionRank(b) || a.statusSince - b.statusSince);
}

export function selectCounts(sessions: SessionInfo[]): { attention: number; working: number; idle: number } {
  const counts = { attention: 0, working: 0, idle: 0 };
  for (const s of sessions) {
    if (s.status === 'attention') counts.attention++;
    else if (s.status === 'working') counts.working++;
    else if (s.status === 'idle') counts.idle++;
  }
  return counts;
}

export interface StoryGroup {
  /** Null for the sessions that belong to no story. */
  story: Story | null;
  sessions: SessionInfo[];
  /** How many of these sessions are waiting for the user. */
  attention: number;
}

const countAttention = (sessions: SessionInfo[]): number => sessions.filter((s) => s.status === 'attention').length;

/**
 * Sessions arranged under their stories. Every story is listed, even an empty one, so that
 * sessions can be started in it. Sessions with no story, or whose story no longer exists,
 * come last in a group of their own, present only when there are such sessions.
 */
export function groupByStory(sessions: SessionInfo[], stories: Story[]): StoryGroup[] {
  const known = new Set(stories.map((s) => s.id));
  const groups: StoryGroup[] = stories.map((story) => {
    const own = sessions.filter((s) => s.storyId === story.id);
    return { story, sessions: own, attention: countAttention(own) };
  });
  const loose = sessions.filter((s) => s.storyId === null || !known.has(s.storyId));
  if (loose.length > 0) groups.push({ story: null, sessions: loose, attention: countAttention(loose) });
  return groups;
}

/** Narrows a list to one story (its id), to the ungrouped sessions (null), or not at all (undefined). */
export function inStory(sessions: SessionInfo[], storyFilter: string | null | undefined, stories: Story[]): SessionInfo[] {
  if (storyFilter === undefined) return sessions;
  if (storyFilter !== null) return sessions.filter((s) => s.storyId === storyFilter);
  const known = new Set(stories.map((s) => s.id));
  return sessions.filter((s) => s.storyId === null || !known.has(s.storyId));
}

export function statusLabel(s: SessionInfo): string {
  if (s.status === 'attention') {
    if (s.reason === 'finished') return 'finished';
    if (s.reason === 'maybe-waiting') return 'maybe waiting';
    return 'needs you';
  }
  return s.status;
}
