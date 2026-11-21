import { lstat, open, readlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ChangedFile, ChangeStatus, ChangeSummary, FileDiff, WorktreeChanges } from '../shared/types.js';
import { GitError, GitRefusal, isInside, runGit, type RunGit } from './git.js';

// The uncommitted changes of a worktree, as git sees them: every file that is not as the last
// commit has it, staged or not, and the files git does not track yet (ignored ones aside).
// Whoever made them (a Claude session, a shell, an editor) is not known: the worktree is shared.

/** The most files listed; a worktree with more says so instead. */
export const MAX_FILES = 1000;
/** A file or a diff longer than this is not shown, only counted as changed. */
export const MAX_DIFF_BYTES = 1024 * 1024;
/** How much of a file is looked at to tell text from binary, as git does. */
const SNIFF_BYTES = 8000;

const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/**
 * Options every read is run with. --no-optional-locks: git status would otherwise take
 * .git/index.lock for a moment to refresh the index, and a `git commit` or `git add` that Claude
 * runs at that very moment would fail. Paths are given as they are, not quoted.
 */
const READ_OPTIONS = ['--no-optional-locks', '-c', 'core.quotePath=false'];

/** How many untracked files are read at the same time. */
const READ_CONCURRENCY = 16;

/** Options every diff is run with: no colours, and never a program the repository names. */
const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

/** The commit changes are counted from: HEAD, or the empty tree in a repository with no commit yet. */
async function baseOf(top: string, run: RunGit): Promise<string> {
  try {
    return (await run([...READ_OPTIONS, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], top)).trim();
  } catch {
    let format = 'sha1';
    try {
      format = (await run([...READ_OPTIONS, 'rev-parse', '--show-object-format'], top)).trim() || 'sha1';
    } catch {
      // An older git knows only sha1.
    }
    return EMPTY_TREE[format] ?? EMPTY_TREE.sha1!;
  }
}

/** The status of a file from the two letters of `git status --porcelain`; null for none worth listing. */
export function statusOf(xy: string): ChangeStatus | null {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (xy === '??') return 'untracked';
  if (xy === '!!') return null;
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflicted';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'T' || y === 'T') return 'typechange';
  if (x === ' ' && y === ' ') return null;
  return 'modified';
}

/**
 * Reads `git status --porcelain=v1 -z`: the path and status of each changed file, each path once.
 * Git can list a path twice: after `git rm --cached f`, f is deleted in the index and untracked
 * in the worktree. The tracked status is kept, as it is the one the diff against HEAD shows.
 */
export function parseStatus(out: string): Array<{ path: string; status: ChangeStatus }> {
  const parts = out.split('\0');
  const byPath = new Map<string, ChangeStatus>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // A rename or copy is followed by the path it came from (not asked for, but harmless).
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const status = statusOf(xy);
    if (!status) continue;
    const path = entry.slice(3);
    const known = byPath.get(path);
    if (known && (status === 'untracked' || known !== 'untracked')) continue;
    byPath.set(path, status);
  }
  return [...byPath].map(([path, status]) => ({ path, status }));
}

/** Reads `git diff --numstat -z`: the lines added and removed per path, null for a binary file. */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const entry of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry.replace(/^\n+/, ''));
    if (!m) continue;
    counts.set(m[3]!, { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) });
  }
  return counts;
}

type Untracked = { data: Buffer } | { binary: true } | { tooLarge: true } | null;

/**
 * A file not tracked yet: its bytes (a link: where it points), or why it is not shown. It is
 * read without blocking, so that the terminals and the page go on while many files are read.
 */
async function readUntracked(file: string): Promise<Untracked> {
  try {
    const st = await lstat(file);
    // A link is shown as git shows it: by where it points, never by the file it points to.
    if (st.isSymbolicLink()) return { data: Buffer.from(await readlink(file)) };
    if (!st.isFile()) return null;
    if (st.size > MAX_DIFF_BYTES) return { tooLarge: true };
    const handle = await open(file, 'r');
    let data: Buffer;
    try {
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (data.length > MAX_DIFF_BYTES) return { tooLarge: true };
    if (data.subarray(0, SNIFF_BYTES).includes(0)) return { binary: true };
    return { data };
  } catch {
    return null;
  }
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, i + 1)) n++;
  return data[data.length - 1] === 10 ? n : n + 1;
}

/** The lines of an untracked file, null for one not shown (binary, too large, gone). */
async function untrackedLines(file: string): Promise<number | null> {
  const read = await readUntracked(file);
  return read && 'data' in read ? lineCount(read.data) : null;
}

/** Maps a list with at most `limit` calls running at once, keeping the order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The whole of a new file as a unified diff, as git would print it against nothing. */
export function newFileDiff(path: string, text: string): string {
  if (text.length === 0) return '';
  const lines = text.split('\n');
  const complete = text.endsWith('\n');
  if (complete) lines.pop();
  const body = lines.map((l) => `+${l}`).join('\n');
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n${complete ? '' : '\\ No newline at end of file\n'}`;
}

const STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'];

async function topOf(folder: string, run: RunGit): Promise<string | null> {
  try {
    return resolve((await run([...READ_OPTIONS, 'rev-parse', '--show-toplevel'], folder)).trim());
  } catch {
    return null;
  }
}

/** The uncommitted changes of the worktree a folder is in; null outside a repository (or without git). */
export async function changesOf(folder: string, run: RunGit = runGit): Promise<WorktreeChanges | null> {
  const top = await topOf(folder, run);
  if (!top) return null;
  const base = await baseOf(top, run);
  const [statusOut, numstatOut] = await Promise.all([
    run([...READ_OPTIONS, ...STATUS_ARGS], top),
    run([...READ_OPTIONS, 'diff', base, '--numstat', '-z', ...DIFF_OPTIONS], top),
  ]);
  const counts = parseNumstat(numstatOut);
  const all = parseStatus(statusOut).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: ChangedFile[] = await mapLimited(all.slice(0, MAX_FILES), READ_CONCURRENCY, async ({ path, status }) => {
    if (status === 'untracked') {
      const lines = await untrackedLines(join(top, path));
      return { path, status, added: lines, removed: lines === null ? null : 0 };
    }
    const c = counts.get(path);
    return { path, status, added: c ? c.added : 0, removed: c ? c.removed : 0 };
  });
  return {
    worktree: top,
    files,
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
    truncated: all.length > files.length,
  };
}

/**
 * What changed in one file of a worktree. Only a file git lists as changed is read, so the
 * path can never reach outside the worktree, nor any file that is as committed.
 */
export async function diffOf(folder: string, path: string, run: RunGit = runGit): Promise<FileDiff> {
  const top = await topOf(folder, run);
  if (!top) throw new GitRefusal('This folder is not in a git repository.');
  const noChanges = new GitRefusal('This file has no uncommitted changes.');
  if (!path || isAbsolute(path) || !isInside(resolve(top, path), top)) throw noChanges;
  // Only this file is looked at: the status of its path, taken literally.
  const statusOut = await run([...READ_OPTIONS, '--literal-pathspecs', ...STATUS_ARGS, '--', path], top);
  const file = parseStatus(statusOut).find((f) => f.path === path);
  if (!file) throw noChanges;
  const result: FileDiff = { path, status: file.status, binary: false, tooLarge: false, diff: '' };

  if (file.status === 'untracked') {
    const read = await readUntracked(join(top, path));
    if (!read) return result;
    if ('binary' in read) return { ...result, binary: true };
    if ('tooLarge' in read) return { ...result, tooLarge: true };
    return { ...result, diff: newFileDiff(path, read.data.toString('utf8')) };
  }

  const base = await baseOf(top, run);
  let out: string;
  try {
    out = await run([...READ_OPTIONS, '--literal-pathspecs', 'diff', base, ...DIFF_OPTIONS, '--', path], top);
  } catch (e) {
    // Larger than git's output may be: too large to show anyway. Told by the code of the error,
    // as the message is git's stderr whenever git wrote any (a CRLF warning, for instance).
    if (e instanceof GitError && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ...result, tooLarge: true };
    throw e;
  }
  if (out.length > MAX_DIFF_BYTES) return { ...result, tooLarge: true };
  if (!out.includes('\n@@') && /^Binary files .* differ$/m.test(out)) return { ...result, binary: true };
  return { ...result, diff: out };
}

/** The figures of a worktree's changes, as sent to the page. */
export function summaryOf(worktree: string, changes: WorktreeChanges | null): ChangeSummary {
  return { worktree, files: changes?.files.length ?? 0, added: changes?.added ?? 0, removed: changes?.removed ?? 0 };
}

function sameSummary(a: ChangeSummary | undefined, b: ChangeSummary): boolean {
  return !!a && a.files === b.files && a.added === b.added && a.removed === b.removed;
}

export interface ChangeTrackerDeps {
  /** Reads the changes of a worktree; null when there are none to read. */
  read: (worktree: string) => Promise<WorktreeChanges | null>;
  /** How long after a hook event the worktree is read again. */
  delayMs?: number;
}

/**
 * Keeps the figures of the uncommitted changes of every worktree sessions work in, for their
 * badges. A worktree is read when a session starts working in it, shortly after Claude uses a
 * tool or ends a turn, and now and then (refreshAll) for changes made elsewhere. Worktrees are
 * keyed by the path the sessions give, so the page finds them under that same path.
 */
export class ChangeTracker {
  private readonly summaries = new Map<string, ChangeSummary>();
  private readonly tracked = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cbs: Array<(list: ChangeSummary[]) => void> = [];
  private stopped = false;

  constructor(private readonly deps: ChangeTrackerDeps) {}

  onChange(cb: (list: ChangeSummary[]) => void): void {
    this.cbs.push(cb);
  }

  /** The worktrees with changes, each once. */
  list(): ChangeSummary[] {
    return [...this.summaries.values()].filter((s) => s.files > 0);
  }

  private emit(): void {
    const list = this.list();
    for (const cb of this.cbs) cb(list);
  }

  /** Sets the worktrees sessions work in: new ones are read at once, the others forgotten. */
  track(worktrees: Iterable<string>): void {
    const next = new Set(worktrees);
    let dropped = false;
    for (const w of [...this.tracked]) {
      if (next.has(w)) continue;
      this.tracked.delete(w);
      clearTimeout(this.timers.get(w));
      this.timers.delete(w);
      if (this.summaries.delete(w)) dropped = true;
    }
    for (const w of next) {
      if (this.tracked.has(w)) continue;
      this.tracked.add(w);
      void this.refresh(w);
    }
    if (dropped) this.emit();
  }

  /** Reads every tracked worktree again. */
  refreshAll(): Promise<void> {
    return Promise.all([...this.tracked].map((w) => this.refresh(w))).then(() => undefined);
  }

  /** Reads a worktree again shortly, once however many times it is asked meanwhile. */
  soon(worktree: string): void {
    if (this.stopped || !this.tracked.has(worktree) || this.timers.has(worktree)) return;
    const t = setTimeout(() => {
      this.timers.delete(worktree);
      void this.refresh(worktree);
    }, this.deps.delayMs ?? 1000);
    t.unref?.();
    this.timers.set(worktree, t);
  }

  /** Takes in changes just read by someone else (the page asking for them). */
  record(worktree: string, changes: WorktreeChanges | null): void {
    if (this.stopped || !this.tracked.has(worktree)) return;
    this.apply(worktree, summaryOf(worktree, changes));
  }

  private apply(worktree: string, summary: ChangeSummary): void {
    if (sameSummary(this.summaries.get(worktree), summary)) return;
    this.summaries.set(worktree, summary);
    this.emit();
  }

  /** Reads a worktree; a read asked for while one runs is made once that one is done. */
  refresh(worktree: string): Promise<void> {
    const current = this.running.get(worktree);
    if (current) {
      this.again.add(worktree);
      return current;
    }
    const run = (async () => {
      let changes: WorktreeChanges | null = null;
      try {
        changes = await this.deps.read(worktree);
      } catch {
        changes = null;
      }
      if (this.stopped || !this.tracked.has(worktree)) return;
      this.apply(worktree, summaryOf(worktree, changes));
    })().finally(() => {
      this.running.delete(worktree);
      if (this.again.delete(worktree) && !this.stopped) void this.refresh(worktree);
    });
    this.running.set(worktree, run);
    return run;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
