import { describe, expect, it } from 'vitest';
import { chipText, isWslSession, moveTargets, samePathWeb, sessionsIn, suggestedFolder, worktreeName } from '../../src/web/worktrees.js';
import type { SessionGit, SessionInfo } from '../../src/shared/types.js';

const git = (over: Partial<SessionGit> = {}): SessionGit => ({ worktree: 'C:\\r\\app-feat', branch: 'feat', head: '1a2b3c4', isMain: false, worktreeCount: 2, ...over });
const session = (id: string, status: string, g: SessionGit | null): SessionInfo => ({ id, status, git: g }) as unknown as SessionInfo;

describe('chipText', () => {
  it('shows branch and worktree name', () => {
    expect(chipText(git())).toBe('⎇ feat · app-feat');
  });
  it('shows the short head when detached', () => {
    expect(chipText(git({ branch: null }))).toBe('⎇ 1a2b3c4 · app-feat');
  });
});

describe('worktreeName', () => {
  it('takes the last segment with either separator', () => {
    expect(worktreeName('C:\\r\\app-feat')).toBe('app-feat');
    expect(worktreeName('/home/me/app-feat')).toBe('app-feat');
    expect(worktreeName('/home/me/app-feat/')).toBe('app-feat');
  });
});

describe('samePathWeb', () => {
  it('ignores separators and trailing slash', () => {
    expect(samePathWeb('C:\\r\\app\\', 'C:/r/app')).toBe(true);
    expect(samePathWeb('/a/b', '/a/b/')).toBe(true);
  });
  it('ignores case only for drive paths', () => {
    expect(samePathWeb('C:\\R\\App', 'c:/r/app')).toBe(true);
    expect(samePathWeb('/a/B', '/a/b')).toBe(false);
    expect(samePathWeb('/a/b', '/a/c')).toBe(false);
  });
});

describe('sessionsIn', () => {
  const list = [
    session('a', 'idle', git()),
    session('b', 'exited', git()),
    session('c', 'busy', git()),
    session('d', 'idle', git({ worktree: 'C:\\r\\other' })),
    session('e', 'idle', null),
  ];
  it('keeps live sessions of that worktree', () => {
    expect(sessionsIn(list, 'C:/r/app-feat').map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('can leave one out', () => {
    expect(sessionsIn(list, 'C:\\r\\app-feat', 'a').map((s) => s.id)).toEqual(['c']);
  });
});

describe('suggestedFolder', () => {
  it('names a sibling of the main worktree', () => {
    expect(suggestedFolder('C:\\r\\app', 'feature/x')).toBe('C:\\r\\app-feature-x');
    expect(suggestedFolder('/home/me/app', 'feature/x')).toBe('/home/me/app-feature-x');
    expect(suggestedFolder('/home/me/app/', 'fix')).toBe('/home/me/app-fix');
  });
});

describe('moveTargets', () => {
  const wt = (path: string, prunable = false) => ({ path, branch: null, head: 'abc1234', isMain: false, locked: false, prunable });
  it('leaves out the current worktree and prunable ones', () => {
    const listing = { current: 'C:\\r\\app', worktrees: [wt('C:/r/app'), wt('C:/r/app-feat'), wt('C:/r/gone', true)] };
    expect(moveTargets(listing, 'C:\\r\\app').map((w) => w.path)).toEqual(['C:/r/app-feat']);
  });
  it('is empty without a listing', () => {
    expect(moveTargets(null, 'x')).toEqual([]);
  });
});

describe('isWslSession', () => {
  it('spots --cd', () => {
    expect(isWslSession(['--cd', '/home'])).toBe(true);
    expect(isWslSession(['-x'])).toBe(false);
    expect(isWslSession(undefined)).toBe(false);
  });
});
