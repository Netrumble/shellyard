import { describe, expect, it } from 'vitest';
import { groupByStory, inStory, selectAttention, selectCounts, statusLabel } from '../../src/web/selectors.js';
import type { SessionInfo, Story } from '../../src/shared/types.js';
import { session } from './session-fixture.js';

const all = [
  session('finished', 'attention', 'finished', 100),
  session('blocked', 'attention', 'blocked', 300),
  session('maybe', 'attention', 'maybe-waiting', 200),
  session('working', 'working'),
  session('idle', 'idle'),
  session('shell', 'running', null, 0, 'shell'),
  session('exited', 'exited'),
];

describe('selectAttention', () => {
  it('puts sessions that cannot continue first, then finished ones, oldest wait first in each group', () => {
    expect(selectAttention(all).map((s) => s.id)).toEqual(['maybe', 'blocked', 'finished']);
  });

  it('orders several finished sessions by how long they have waited', () => {
    const list = [session('b', 'attention', 'finished', 50), session('a', 'attention', 'finished', 10), session('c', 'attention', 'blocked', 90)];
    expect(selectAttention(list).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('is empty when nothing waits', () => {
    expect(selectAttention([session('w', 'working')])).toEqual([]);
  });

  it('does not reorder the list it was given', () => {
    const copy = [...all];
    selectAttention(all);
    expect(all).toEqual(copy);
  });
});

describe('selectCounts', () => {
  it('counts attention, working and idle sessions only', () => {
    expect(selectCounts(all)).toEqual({ attention: 3, working: 1, idle: 1 });
  });
  it('is all zero for no sessions', () => {
    expect(selectCounts([])).toEqual({ attention: 0, working: 0, idle: 0 });
  });
});

describe('statusLabel', () => {
  it('names every state in plain words', () => {
    expect(statusLabel(session('a', 'attention', 'blocked'))).toBe('needs you');
    expect(statusLabel(session('a', 'attention', 'maybe-waiting'))).toBe('maybe waiting');
    expect(statusLabel(session('a', 'attention', 'finished'))).toBe('finished');
    expect(statusLabel(session('a', 'working'))).toBe('working');
    expect(statusLabel(session('a', 'idle'))).toBe('idle');
    expect(statusLabel(session('a', 'running', null, 0, 'shell'))).toBe('running');
    expect(statusLabel(session('a', 'exited'))).toBe('exited');
  });
});

describe('stories', () => {
  const story = (id: string): Story => ({ id, name: id.toUpperCase(), ticket: '', cwd: '', color: '', sound: '' });
  const inS = (s: SessionInfo, storyId: string | null): SessionInfo => ({ ...s, storyId });
  const a1 = inS(session('a1', 'attention', 'blocked'), 'a');
  const a2 = inS(session('a2', 'working'), 'a');
  const b1 = inS(session('b1', 'attention', 'finished'), 'b');
  const free = session('free', 'idle');
  const orphan = inS(session('orphan', 'attention', 'blocked'), 'deleted-story');

  describe('groupByStory', () => {
    it('lists stories in their order with their sessions, then the ungrouped ones', () => {
      const groups = groupByStory([free, b1, a1, a2], [story('a'), story('b')]);
      expect(groups.map((g) => [g.story?.id ?? null, g.sessions.map((s) => s.id)])).toEqual([
        ['a', ['a1', 'a2']],
        ['b', ['b1']],
        [null, ['free']],
      ]);
    });
    it('keeps a story that has no session, so new sessions can be started in it', () => {
      const groups = groupByStory([], [story('a')]);
      expect(groups).toEqual([{ story: story('a'), sessions: [], attention: 0 }]);
    });
    it('has no ungrouped group when every session is in a story', () => {
      expect(groupByStory([a1], [story('a')]).map((g) => g.story?.id ?? null)).toEqual(['a']);
    });
    it('treats a session whose story no longer exists as ungrouped', () => {
      const groups = groupByStory([orphan], [story('a')]);
      expect(groups.map((g) => [g.story?.id ?? null, g.sessions.map((s) => s.id)])).toEqual([['a', []], [null, ['orphan']]]);
    });
    it('counts the sessions that need attention in each group', () => {
      const groups = groupByStory([a1, a2, b1, free, orphan], [story('a'), story('b')]);
      expect(groups.map((g) => g.attention)).toEqual([1, 1, 1]);
    });
    it('is empty with nothing at all', () => {
      expect(groupByStory([], [])).toEqual([]);
    });
  });

  describe('inStory', () => {
    const list = [a1, a2, b1, free, orphan];
    const known = [story('a'), story('b')];
    it('returns everything when there is no filter', () => {
      expect(inStory(list, undefined, known)).toEqual(list);
    });
    it('returns the sessions of one story', () => {
      expect(inStory(list, 'a', known).map((s) => s.id)).toEqual(['a1', 'a2']);
    });
    it('returns the ungrouped sessions for null, including those whose story is gone', () => {
      expect(inStory(list, null, known).map((s) => s.id)).toEqual(['free', 'orphan']);
    });
  });
});
