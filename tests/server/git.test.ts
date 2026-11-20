import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branches, headOf, samePath, worktreeStatus, worktreesOf } from '../../src/server/git.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'first');
}

describe('samePath', () => {
  it.runIf(process.platform === 'win32')('ignores case, separators and a trailing slash on Windows', () => {
    expect(samePath('C:/repos/a', 'c:\\repos\\a\\')).toBe(true);
  });
  it('tells different paths apart', () => {
    expect(samePath('/a/b', '/a/c')).toBe(false);
  });
});

describe.skipIf(!hasGit)('git worktrees', () => {
  let root = '';
  let repo = '';
  let wtDir = '';
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'shellyard-git-')));
    repo = join(root, 'repo');
    wtDir = join(root, 'wt');
    makeRepo(repo);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('worktreesOf returns null outside a repository', async () => {
    expect(await worktreesOf(join(root))).toBeNull();
  });

  it('lists the main worktree and a linked one', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    const l = await worktreesOf(repo);
    expect(l!.worktrees.length).toBe(2);
    expect(l!.worktrees[0]!.isMain).toBe(true);
    expect(l!.worktrees[0]!.branch).toBe('main');
    expect(l!.worktrees[1]!.branch).toBe('feat');
    expect(samePath(l!.worktrees[1]!.path, wtDir)).toBe(true);
    expect(l!.worktrees[1]!.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('current is the worktree a sub-folder belongs to', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    mkdirSync(join(wtDir, 'sub'));
    const l = await worktreesOf(join(wtDir, 'sub'));
    expect(samePath(l!.current, wtDir)).toBe(true);
  });

  it('reports a detached worktree with branch null', async () => {
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    const l = await worktreesOf(repo);
    const w = l!.worktrees.find((x) => samePath(x.path, det))!;
    expect(w.branch).toBeNull();
  });

  it('marks a worktree whose folder is gone as prunable', async () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    rmSync(wtDir, { recursive: true, force: true });
    const l = await worktreesOf(repo);
    expect(l!.worktrees.find((x) => samePath(x.path, wtDir))!.prunable).toBe(true);
  });

  it('headOf reads the branch of the main and of a linked worktree', () => {
    git(repo, 'worktree', 'add', '-b', 'feat', wtDir);
    expect(headOf(repo)!.branch).toBe('main');
    expect(headOf(repo)!.head).toMatch(/^[0-9a-f]{7}$/);
    expect(headOf(wtDir)!.branch).toBe('feat');
    git(wtDir, 'switch', '-c', 'other');
    expect(headOf(wtDir)!.branch).toBe('other');
  });

  it('headOf reports a detached worktree and null outside a repository', () => {
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    const h = headOf(det)!;
    expect(h.branch).toBeNull();
    expect(h.head).toHaveLength(7);
    expect(headOf(root)).toBeNull();
  });

  it('headOf finds a branch that only packed-refs knows', () => {
    git(repo, 'pack-refs', '--all');
    const h = headOf(repo)!;
    expect(h.branch).toBe('main');
    expect(h.head).toMatch(/^[0-9a-f]{7}$/);
  });

  it('worktreeStatus tells clean, dirty and unreachable commits', async () => {
    expect(await worktreeStatus(repo)).toEqual({ dirty: false, unreachable: 0 });
    writeFileSync(join(repo, 'new.txt'), 'x');
    expect((await worktreeStatus(repo)).dirty).toBe(true);
    const det = join(root, 'det');
    git(repo, 'worktree', 'add', '--detach', det);
    writeFileSync(join(det, 'b.txt'), 'b');
    git(det, 'add', '.');
    git(det, 'commit', '-m', 'second');
    expect(await worktreeStatus(det)).toEqual({ dirty: false, unreachable: 1 });
  });

  it('branches lists local branches', async () => {
    git(repo, 'branch', 'feat');
    const b = await branches(repo);
    expect(b).toContain('main');
    expect(b).toContain('feat');
  });
});
