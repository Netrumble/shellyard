import { describe, expect, it } from 'vitest';
import { branchLabel, branchNameFor, chipText, countOf, deleteConfirmations, freeBranches, isWslSession, leaveDetachedPrompt, moveTargets, joinPath, relativeInside, samePathWeb, sessionChoices, sessionsIn, suggestedFolder, worktreeName } from '../../src/web/worktrees.js';
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

describe('branchLabel', () => {
  it('shows the branch', () => {
    expect(branchLabel(git())).toBe('⎇ feat');
  });
  it('shows the short head when detached', () => {
    expect(branchLabel(git({ branch: null }))).toBe('⎇ 1a2b3c4');
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
  it('leaves out .git for a bare repository', () => {
    expect(suggestedFolder('/r/app.git', 'feat', true)).toBe('/r/app-feat');
    expect(suggestedFolder('C:\\r\\app.git\\', 'feature/x', true)).toBe('C:\\r\\app-feature-x');
    expect(suggestedFolder('/r/app/.git', 'feat', true)).toBe('/r/app-feat');
    expect(suggestedFolder('/r/app', 'feat', true)).toBe('/r/app-feat');
  });
});

describe('countOf', () => {
  it('says one or many', () => {
    expect(countOf(1, 'commit', 'commits')).toBe('1 commit');
    expect(countOf(3, 'commit', 'commits')).toBe('3 commits');
  });
});

const entry = (path: string, o: { prunable?: boolean; bare?: boolean; isMain?: boolean } = {}) => ({
  path,
  branch: null,
  head: 'abc1234',
  isMain: o.isMain ?? false,
  locked: false,
  prunable: o.prunable ?? false,
  bare: o.bare ?? false,
});

describe('moveTargets', () => {
  it('leaves out the current worktree and prunable ones', () => {
    const listing = { current: 'C:\\r\\app', worktrees: [entry('C:/r/app'), entry('C:/r/app-feat'), entry('C:/r/gone', { prunable: true })] };
    expect(moveTargets(listing, 'C:\\r\\app').map((w) => w.path)).toEqual(['C:/r/app-feat']);
  });
  it('leaves out the entry of a bare repository', () => {
    const listing = { current: '/r/app-a', worktrees: [entry('/r/app.git', { bare: true, isMain: true }), entry('/r/app-a'), entry('/r/app-b')] };
    expect(moveTargets(listing, '/r/app-a').map((w) => w.path)).toEqual(['/r/app-b']);
  });
  it('is empty without a listing', () => {
    expect(moveTargets(null, 'x')).toEqual([]);
  });
});

describe('branchNameFor', () => {
  const listing = {
    current: 'C:\\r\\app',
    worktrees: [
      { ...entry('C:\\r\\app', { isMain: true }), branch: 'main' },
      { ...entry('C:\\r\\app-feat'), branch: 'feature/x' },
      entry('C:\\r\\app-det'),
    ],
  };
  it('is the branch of the chosen worktree', () => {
    expect(branchNameFor(listing, 'c:/r/app-feat/')).toBe('feature/x');
  });
  it('is the branch of the current worktree when none is chosen', () => {
    expect(branchNameFor(listing, '')).toBe('main');
  });
  it('is null for a detached worktree, an unknown path or no listing', () => {
    expect(branchNameFor(listing, 'C:\\r\\app-det')).toBeNull();
    expect(branchNameFor(listing, 'C:\\elsewhere')).toBeNull();
    expect(branchNameFor(null, 'C:\\r\\app')).toBeNull();
  });
});

describe('sessionChoices', () => {
  it('offers the worktrees a session can start in: not bare, not prunable unless current', () => {
    const listing = {
      current: '/r/gone',
      worktrees: [entry('/r/app.git', { bare: true, isMain: true }), entry('/r/app-a'), entry('/r/gone', { prunable: true }), entry('/r/old', { prunable: true })],
    };
    expect(sessionChoices(listing).map((w) => w.path)).toEqual(['/r/app-a', '/r/gone']);
  });
  it('is empty without a listing', () => {
    expect(sessionChoices(null)).toEqual([]);
  });
});

describe('leaveDetachedPrompt', () => {
  it('asks only when commits would be left behind, with the right plural', () => {
    expect(leaveDetachedPrompt(0)).toBeNull();
    expect(leaveDetachedPrompt(1)).toBe('1 commit on no branch will be left behind (recoverable only from the reflog). Continue?');
    expect(leaveDetachedPrompt(2)).toBe('2 commits on no branch will be left behind (recoverable only from the reflog). Continue?');
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
      prompts: ['1 commit on no branch will be lost.', final],
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
  const wt = (branch: string | null) => ({ path: `/r/${branch ?? 'x'}`, branch, head: 'abc1234', isMain: false, locked: false, prunable: false, bare: false });
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
