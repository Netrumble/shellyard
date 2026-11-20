import { describe, expect, it } from 'vitest';
import { chipText, deleteConfirmations, freeBranches, isWslSession, moveTargets, joinPath, relativeInside, samePathWeb, sessionsIn, suggestedFolder, worktreeName } from '../../src/web/worktrees.js';
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

describe('deleteConfirmations', () => {
  const path = 'C:\\r\\app-feat';
  const final = `Delete worktree ${path}? Files ignored by git (like .env) are deleted too.`;
  it('asks only the final question for a clean worktree with no sessions', () => {
    expect(deleteConfirmations({ sessionNames: [], path, prunable: false, detached: false, status: { dirty: false, unreachable: 0 } })).toEqual({ prompts: [final], force: false });
  });
  it('asks in order: sessions, changes, lost commits, then the final question, and forces', () => {
    expect(deleteConfirmations({ sessionNames: ['a', 'b'], path, prunable: false, detached: false, status: { dirty: true, unreachable: 3 } })).toEqual({
      prompts: ['Close a, b and delete?', `Uncommitted changes in ${path} will be lost.`, '3 commits on no branch will be lost.', final],
      force: true,
    });
  });
  it('forces for lost commits alone', () => {
    expect(deleteConfirmations({ sessionNames: [], path, prunable: false, detached: false, status: { dirty: false, unreachable: 1 } })).toEqual({
      prompts: ['1 commits on no branch will be lost.', final],
      force: true,
    });
  });
  it('asks about changes when the status is unknown, before forcing', () => {
    expect(deleteConfirmations({ sessionNames: ['a'], path, prunable: false, detached: false, status: null })).toEqual({
      prompts: ['Close a and delete?', `Could not read the status of ${path}; any uncommitted changes will be lost.`, final],
      force: true,
    });
  });
  it('also warns about commits on no branch when the status is unknown and the worktree is detached', () => {
    expect(deleteConfirmations({ sessionNames: [], path, prunable: false, detached: true, status: null })).toEqual({
      prompts: [
        `Could not read the status of ${path}; any uncommitted changes will be lost.`,
        `Commits on no branch (if any) in ${path} will be lost.`,
        final,
      ],
      force: true,
    });
  });
  it('trusts a known status of a detached worktree', () => {
    expect(deleteConfirmations({ sessionNames: [], path, prunable: false, detached: true, status: { dirty: false, unreachable: 0 } })).toEqual({ prompts: [final], force: false });
  });
  it('has nothing to lose in a prunable worktree, whose folder is gone', () => {
    expect(deleteConfirmations({ sessionNames: [], path, prunable: true, detached: false, status: null })).toEqual({ prompts: [final], force: false });
  });
});

describe('freeBranches', () => {
  const wt = (branch: string | null) => ({ path: `/r/${branch ?? 'x'}`, branch, head: 'abc1234', isMain: false, locked: false, prunable: false });
  it('leaves out the branches checked out in a worktree', () => {
    expect(freeBranches(['main', 'feat', 'fix'], { current: '/r/main', worktrees: [wt('main'), wt(null), wt('feat')] })).toEqual(['fix']);
  });
  it('keeps every branch without a listing', () => {
    expect(freeBranches(['main'], null)).toEqual(['main']);
  });
});

describe('relativeInside', () => {
  it('gives the part of a folder below the root, on Windows paths', () => {
    expect(relativeInside('C:\\r\\app\\packages\\web', 'c:/r/app/')).toBe('packages\\web');
  });
  it('gives the part below the root on POSIX paths', () => {
    expect(relativeInside('/r/app/src/web', '/r/app')).toBe('src/web');
  });
  it('is empty when the folder is the root', () => {
    expect(relativeInside('/r/app/', '/r/app')).toBe('');
  });
  it('is null outside the root, also for a sibling with the same prefix', () => {
    expect(relativeInside('/r/app-two/x', '/r/app')).toBeNull();
    expect(relativeInside('/other', '/r/app')).toBeNull();
  });
});

describe('joinPath', () => {
  it('keeps the separator style of the root', () => {
    expect(joinPath('C:\\r\\wt', 'packages/web')).toBe('C:\\r\\wt\\packages\\web');
    expect(joinPath('/r/wt/', 'packages\\web')).toBe('/r/wt/packages/web');
  });
  it('is the root when there is nothing to add', () => {
    expect(joinPath('/r/wt', '')).toBe('/r/wt');
  });
});
