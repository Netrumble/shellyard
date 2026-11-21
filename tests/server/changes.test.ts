import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeTracker, changesOf, diffOf, newFileDiff, parseNumstat, parseStatus, statusOf } from '../../src/server/changes.js';
import { GitError, GitRefusal, runGit, type RunGit } from '../../src/server/git.js';
import type { WorktreeChanges } from '../../src/shared/types.js';
import { removeDir } from '../helpers.js';

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(dir: string, commit = true): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (!commit) return;
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'gone.txt'), 'bye\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'b.txt'), 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'first');
}

describe('statusOf', () => {
  it('reads the two letters of git status', () => {
    expect(statusOf(' M')).toBe('modified');
    expect(statusOf('M ')).toBe('modified');
    expect(statusOf('MM')).toBe('modified');
    expect(statusOf('A ')).toBe('added');
    expect(statusOf(' D')).toBe('deleted');
    expect(statusOf('??')).toBe('untracked');
    expect(statusOf('UU')).toBe('conflicted');
    expect(statusOf('AA')).toBe('conflicted');
    expect(statusOf(' T')).toBe('typechange');
    expect(statusOf('!!')).toBeNull();
  });
});

describe('parseStatus', () => {
  it('reads paths with spaces, and skips the origin of a rename', () => {
    expect(parseStatus(' M a b.txt\0R  new.txt\0old.txt\0?? x\0')).toEqual([
      { path: 'a b.txt', status: 'modified' },
      { path: 'new.txt', status: 'modified' },
      { path: 'x', status: 'untracked' },
    ]);
  });

  it('lists a path once, with its tracked status, when git gives it twice', () => {
    expect(parseStatus('D  f\0?? f\0?? g\0')).toEqual([
      { path: 'f', status: 'deleted' },
      { path: 'g', status: 'untracked' },
    ]);
    expect(parseStatus('?? f\0D  f\0')).toEqual([{ path: 'f', status: 'deleted' }]);
  });
});

describe('parseNumstat', () => {
  it('reads counts, and null for a binary file', () => {
    const m = parseNumstat('3\t1\ta.txt\0-\t-\timg.png\0');
    expect(m.get('a.txt')).toEqual({ added: 3, removed: 1 });
    expect(m.get('img.png')).toEqual({ added: null, removed: null });
  });
});

describe('newFileDiff', () => {
  it('shows every line as added', () => {
    expect(newFileDiff('n.txt', 'a\nb\n')).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n');
  });
  it('says when the last line has no newline', () => {
    expect(newFileDiff('n.txt', 'a')).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+a\n\\ No newline at end of file\n');
  });
  it('is empty for an empty file', () => {
    expect(newFileDiff('n.txt', '')).toBe('');
  });
});

describe.runIf(hasGit)('changesOf and diffOf', () => {
  let root = '';
  let repo = '';
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'shellyard-changes-')));
    repo = join(root, 'repo');
    makeRepo(repo);
  });
  afterEach(() => removeDir(root));

  it('is null outside a repository', async () => {
    expect(await changesOf(root)).toBeNull();
  });

  it('is empty when nothing changed', async () => {
    expect(await changesOf(repo)).toEqual({ worktree: repo, files: [], added: 0, removed: 0, truncated: false });
  });

  it('lists modified, staged, deleted and new files with their lines, from any sub-folder', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\nfour\n');
    unlinkSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, 'staged.txt'), 'x\ny\n');
    git(repo, 'add', 'staged.txt');
    writeFileSync(join(repo, 'src', 'new file.txt'), 'n1\nn2\nn3');
    const c = await changesOf(join(repo, 'src'));
    expect(c).toEqual({
      worktree: repo,
      files: [
        { path: 'a.txt', status: 'modified', added: 2, removed: 1 },
        { path: 'gone.txt', status: 'deleted', added: 0, removed: 1 },
        { path: 'src/new file.txt', status: 'untracked', added: 3, removed: 0 },
        { path: 'staged.txt', status: 'added', added: 2, removed: 0 },
      ],
      added: 7,
      removed: 2,
      truncated: false,
    });
  });

  it('leaves ignored files out', async () => {
    writeFileSync(join(repo, '.gitignore'), '*.log\n');
    writeFileSync(join(repo, 'debug.log'), 'noise\n');
    const c = await changesOf(repo);
    expect(c?.files.map((f) => f.path)).toEqual(['.gitignore']);
  });

  it('works in a repository with no commit yet', async () => {
    const fresh = join(root, 'fresh');
    makeRepo(fresh, false);
    writeFileSync(join(fresh, 'a.txt'), 'a\n');
    writeFileSync(join(fresh, 'b.txt'), 'b\nc\n');
    git(fresh, 'add', 'b.txt');
    const c = await changesOf(fresh);
    expect(c?.files).toEqual([
      { path: 'a.txt', status: 'untracked', added: 1, removed: 0 },
      { path: 'b.txt', status: 'added', added: 2, removed: 0 },
    ]);
    expect((await diffOf(fresh, 'b.txt')).diff).toContain('+c');
  });

  it('gives the diff of a modified file against the last commit, staged or not', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\n');
    git(repo, 'add', 'a.txt');
    writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\nfour\n');
    const d = await diffOf(repo, 'a.txt');
    expect(d).toMatchObject({ path: 'a.txt', status: 'modified', binary: false, tooLarge: false });
    expect(d.diff).toContain('@@');
    expect(d.diff).toContain('-two');
    expect(d.diff).toContain('+2');
    expect(d.diff).toContain('+four');
  });

  it('gives a deleted file as all lines removed, and a new one as all lines added', async () => {
    unlinkSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, 'n.txt'), 'hello\n');
    expect((await diffOf(repo, 'gone.txt')).diff).toContain('-bye');
    expect((await diffOf(repo, 'n.txt')).diff).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+hello\n');
  });

  it('says a binary file is binary', async () => {
    writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 3]));
    expect((await changesOf(repo))?.files).toEqual([{ path: 'img.bin', status: 'untracked', added: null, removed: null }]);
    expect(await diffOf(repo, 'img.bin')).toMatchObject({ binary: true, diff: '' });
    git(repo, 'add', 'img.bin');
    git(repo, 'commit', '-m', 'bin');
    writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 9, 9, 0]));
    expect(await diffOf(repo, 'img.bin')).toMatchObject({ status: 'modified', binary: true, diff: '' });
  });

  // '[a].txt' read as a pattern is 'a.txt': its diff must not show up. (Brackets, as '*' and '?'
  // are not allowed in a file name on Windows.)
  it('takes pathspec characters in a name literally', async () => {
    writeFileSync(join(repo, '[a].txt'), 'star\n');
    git(repo, 'add', ':(literal)[a].txt');
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const d = await diffOf(repo, '[a].txt');
    expect(d.diff).toContain('+star');
    expect(d.diff).not.toContain('changed');
  });

  it('refuses a file that has no changes, or one outside the worktree', async () => {
    writeFileSync(join(root, 'secret.txt'), 'secret\n');
    await expect(diffOf(repo, 'a.txt')).rejects.toBeInstanceOf(GitRefusal);
    await expect(diffOf(repo, '../secret.txt')).rejects.toBeInstanceOf(GitRefusal);
    await expect(diffOf(root, 'secret.txt')).rejects.toBeInstanceOf(GitRefusal);
  });

  it('lists a file removed from the index but kept on disk once', async () => {
    git(repo, 'rm', '--cached', '-q', 'a.txt');
    const c = await changesOf(repo);
    expect(c?.files).toEqual([{ path: 'a.txt', status: 'deleted', added: 0, removed: 3 }]);
    expect(await diffOf(repo, 'a.txt')).toMatchObject({ status: 'deleted' });
  });

  it('never takes the index lock, so that a commit made meanwhile does not fail', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const seen: string[][] = [];
    const run: RunGit = (args, cwd) => {
      seen.push(args);
      return runGit(args, cwd);
    };
    await changesOf(repo, run);
    await diffOf(repo, 'a.txt', run);
    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) expect(args[0]).toBe('--no-optional-locks');
  });

  it('calls a diff larger than git may print too large, even when git warned on stderr', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const run: RunGit = (args, cwd) =>
      args.includes('diff') && args.includes('a.txt')
        ? Promise.reject(new GitError('warning: in the working copy of a.txt, LF will be replaced by CRLF', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))
        : runGit(args, cwd);
    expect(await diffOf(repo, 'a.txt', run)).toMatchObject({ tooLarge: true, diff: '' });
  });

  it.runIf(process.platform !== 'win32')('shows a new link by where it points, never by what it points to', async () => {
    writeFileSync(join(root, 'secret.txt'), 'secret\n');
    symlinkSync(join(root, 'secret.txt'), join(repo, 'link'));
    const d = await diffOf(repo, 'link');
    expect(d.diff).toContain(`+${join(root, 'secret.txt')}`);
    expect(d.diff).not.toContain('+secret\n');
  });
});

function changes(worktree: string, files: number): WorktreeChanges {
  return {
    worktree,
    files: Array.from({ length: files }, (_, i) => ({ path: `f${i}`, status: 'modified' as const, added: 1, removed: 0 })),
    added: files,
    removed: 0,
    truncated: false,
  };
}

describe('ChangeTracker', () => {
  afterEach(() => vi.useRealTimers());

  it('reads a worktree when it starts being tracked, and lists only those with changes', async () => {
    const read = vi.fn(async (w: string) => changes(w, w === '/a' ? 2 : 0));
    const t = new ChangeTracker({ read });
    const seen: unknown[] = [];
    t.onChange((l) => seen.push(l));
    t.track(['/a', '/b']);
    await t.refreshAll();
    expect(t.list()).toEqual([{ worktree: '/a', files: 2, added: 2, removed: 0 }]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('forgets a worktree no longer tracked, and says so', async () => {
    const t = new ChangeTracker({ read: async (w) => changes(w, 1) });
    t.track(['/a']);
    await t.refreshAll();
    const seen: unknown[] = [];
    t.onChange((l) => seen.push(l));
    t.track([]);
    expect(t.list()).toEqual([]);
    expect(seen).toEqual([[]]);
  });

  it('does not announce the same figures twice', async () => {
    const t = new ChangeTracker({ read: async (w) => changes(w, 1) });
    t.track(['/a']);
    await t.refreshAll();
    const cb = vi.fn();
    t.onChange(cb);
    await t.refreshAll();
    t.record('/a', changes('/a', 1));
    expect(cb).not.toHaveBeenCalled();
  });

  it('reads once more, not once per ask, when asked while reading', async () => {
    let release: () => void = () => {};
    const read = vi.fn(
      (w: string) =>
        new Promise<WorktreeChanges>((r) => {
          release = () => r(changes(w, 1));
        }),
    );
    const t = new ChangeTracker({ read });
    t.track(['/a']);
    void t.refresh('/a');
    void t.refresh('/a');
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    release();
  });

  it('reads shortly after being told, once for many tells', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (w: string) => changes(w, 1));
    const t = new ChangeTracker({ read, delayMs: 500 });
    t.track(['/a']);
    await vi.advanceTimersByTimeAsync(0);
    read.mockClear();
    t.soon('/a');
    t.soon('/a');
    t.soon('/untracked');
    await vi.advanceTimersByTimeAsync(499);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    t.stop();
  });

  it('ignores figures for a worktree it does not track', () => {
    const t = new ChangeTracker({ read: async () => null });
    t.record('/x', changes('/x', 3));
    expect(t.list()).toEqual([]);
  });
});
