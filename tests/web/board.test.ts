import { describe, expect, it } from 'vitest';
import { areaBranch, areaSummary, boardAreas, byActivity, glyphCounts } from '../../src/web/board.js';
import type { SessionInfo, Story } from '../../src/shared/types.js';
import { session } from './session-fixture.js';

const area = (id: string): Story => ({ id, name: id.toUpperCase(), ticket: '', cwd: '', color: '', sound: '' });
const inArea = (s: SessionInfo, storyId: string | null): SessionInfo => ({ ...s, storyId });

describe('boardAreas', () => {
  const a = area('a');
  const b = area('b');
  const c = area('c');

  it('gives one area per story, each with its sessions, and a last one for sessions with no area', () => {
    const sessions = [inArea(session('s1', 'working'), 'a'), inArea(session('s2', 'idle'), 'b'), session('loose', 'running', null, 0, 'shell')];
    const areas = boardAreas(sessions, [a, b]);
    expect(areas.map((x) => [x.story?.id ?? null, x.sessions.map((s) => s.id)])).toEqual([
      ['a', ['s1']],
      ['b', ['s2']],
      [null, ['loose']],
    ]);
  });

  it('keeps the story order even when a later area is waiting', () => {
    const sessions = [inArea(session('s1', 'working'), 'a'), inArea(session('s2', 'attention', 'blocked'), 'b'), inArea(session('s3', 'attention', 'finished'), 'c')];
    expect(boardAreas(sessions, [a, b, c]).map((x) => x.story?.id ?? null)).toEqual(['a', 'b', 'c', null]);
  });

  it('keeps the area for sessions with no area last, even when one of them is waiting', () => {
    const sessions = [inArea(session('s1', 'working'), 'a'), session('loose', 'attention', 'blocked')];
    expect(boardAreas(sessions, [a]).map((x) => x.story?.id ?? null)).toEqual(['a', null]);
  });

  it('says what each area is doing: waiting beats working, working beats quiet', () => {
    const sessions = [
      inArea(session('s1', 'working'), 'a'),
      inArea(session('s2', 'attention', 'maybe-waiting'), 'a'),
      inArea(session('s3', 'working'), 'b'),
      inArea(session('s4', 'idle'), 'b'),
      inArea(session('s5', 'exited'), 'c'),
      inArea(session('s6', 'idle'), 'c'),
    ];
    const byId = Object.fromEntries(boardAreas(sessions, [a, b, c]).map((x) => [x.story?.id ?? 'none', x.state]));
    expect(byId).toEqual({ a: 'attention', b: 'working', c: 'quiet', none: 'quiet' });
  });

  it('counts a running shell as working', () => {
    const areas = boardAreas([inArea(session('sh', 'running', null, 0, 'shell'), 'a')], [a]);
    expect(areas[0]!.state).toBe('working');
  });

  it('always offers the area for sessions with none when there are areas, so that a session can be taken out of one', () => {
    expect(boardAreas([], [a]).map((x) => x.story?.id ?? null)).toEqual(['a', null]);
  });

  it('shows only the sessions when there are no areas yet, and nothing at all when there is nothing', () => {
    expect(boardAreas([session('s', 'idle')], []).map((x) => x.story?.id ?? null)).toEqual([null]);
    expect(boardAreas([], [])).toEqual([]);
  });

  it('treats a session whose area was deleted as having none', () => {
    const areas = boardAreas([inArea(session('orphan', 'idle'), 'gone')], [a]);
    expect(areas.find((x) => x.story === null)!.sessions.map((s) => s.id)).toEqual(['orphan']);
  });
});

describe('areaSummary', () => {
  it('says how many are waiting, working and finished, most pressing first', () => {
    const sessions = [session('1', 'attention', 'blocked'), session('2', 'attention', 'finished'), session('3', 'working'), session('4', 'working'), session('5', 'idle'), session('6', 'exited')];
    expect(areaSummary(sessions)).toBe('1 needs you, 1 finished, 2 working, 1 idle, 1 exited');
  });
  it('counts a session that may be waiting among those that need you', () => {
    expect(areaSummary([session('1', 'attention', 'maybe-waiting'), session('2', 'attention', 'blocked')])).toBe('2 need you');
  });
  it('says so when an area is empty', () => {
    expect(areaSummary([])).toBe('No sessions');
  });
});

describe('byActivity', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(area);
  const ids = (sessions: SessionInfo[]) => byActivity(boardAreas(sessions, [a!, b!, c!, d!])).map((x) => x.story?.id ?? null);

  it('floats areas up by what they need: waiting, then working, then finished, then quiet', () => {
    const sessions = [
      inArea(session('q', 'idle'), 'a'),
      inArea(session('f', 'attention', 'finished'), 'b'),
      inArea(session('w', 'working'), 'c'),
      inArea(session('n', 'attention', 'blocked'), 'd'),
    ];
    expect(ids(sessions)).toEqual(['d', 'c', 'b', 'a', null]);
  });

  it('keeps the order the user gave within the same level', () => {
    const sessions = [inArea(session('w1', 'working'), 'b'), inArea(session('w2', 'working'), 'd'), inArea(session('m', 'attention', 'maybe-waiting'), 'c')];
    expect(ids(sessions)).toEqual(['c', 'b', 'd', 'a', null]);
  });

  it('does not count a shell that merely runs as activity', () => {
    const sessions = [inArea(session('sh', 'running', null, 0, 'shell'), 'b'), inArea(session('i', 'idle'), 'a')];
    expect(ids(sessions)).toEqual(['a', 'b', 'c', 'd', null]);
  });

  it('keeps the area for sessions with no area last', () => {
    expect(ids([session('loose', 'attention', 'blocked')])).toEqual(['a', 'b', 'c', 'd', null]);
  });
});

describe('glyphCounts', () => {
  it('counts the sessions of an area by glyph, a quiet shell as idle and an ended one as exited', () => {
    const sessions = [
      session('n', 'attention', 'blocked'),
      session('m', 'attention', 'maybe-waiting'),
      session('w', 'working'),
      session('f', 'attention', 'finished'),
      session('i', 'idle'),
      session('sh', 'running', null, 0, 'shell'),
      session('x', 'exited'),
    ];
    expect(glyphCounts(sessions, {})).toEqual({ needs: 2, working: 1, finished: 1, idle: 2, exited: 1 });
    expect(glyphCounts(sessions, { sh: 300 })).toEqual({ needs: 2, working: 2, finished: 1, idle: 1, exited: 1 });
  });
});

describe('areaBranch', () => {
  const onBranch = (id: string, branch: string | null): SessionInfo => ({ ...session(id, 'idle'), git: { worktree: '/r', branch, head: 'abc1234', isMain: false, worktreeCount: 2 } });

  it('is the branch most of its sessions are on', () => {
    expect(areaBranch([onBranch('1', 'feat/a'), onBranch('2', 'main'), onBranch('3', 'feat/a')])).toBe('feat/a');
  });

  it('is null when no session knows its branch', () => {
    expect(areaBranch([session('1', 'idle'), onBranch('2', null)])).toBeNull();
    expect(areaBranch([])).toBeNull();
  });
});
