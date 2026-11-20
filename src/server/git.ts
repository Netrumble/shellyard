import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Worktree, WorktreeListing } from '../shared/types.js';

/** The message is git's trimmed stderr, or a validation message. */
export class GitError extends Error {}

/** A request this module turns down itself (main worktree, not a worktree, bad name...): never worth retrying. */
export class GitRefusal extends GitError {}

/**
 * What git says when a folder is still held by a process that is going away (Windows keeps the
 * cwd of a dying process busy for a moment): "Permission denied", "Device or resource busy",
 * "being used by another process", "Directory not empty", "failed to delete", "unable to ...".
 */
const BUSY = /busy|permission denied|being used|not empty|failed to delete|unable to/i;

/**
 * Runs a git operation again, a few times and a short while apart, while it fails because a folder
 * is busy. Refusals and other git errors (like changes that need force) are thrown at once.
 */
export async function retryWhileBusy<T>(
  fn: () => Promise<T>,
  o: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = o.attempts ?? 5;
  const delayMs = o.delayMs ?? 400;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (e) {
      const busy = e instanceof GitError && !(e instanceof GitRefusal) && BUSY.test(e.message);
      if (!busy || i >= attempts) throw e;
      await sleep(delayMs);
    }
  }
}

const TIMEOUT_MS = 15000;

/** Runs git without a shell and returns stdout. Throws GitError when git fails or is missing. */
export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const text = String(stderr ?? '').trim();
          reject(new GitError(text || error.message));
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

let gitAvailable: Promise<boolean> | null = null;

export function hasGit(): Promise<boolean> {
  gitAvailable ??= runGit(['--version'], process.cwd()).then(
    () => true,
    () => false,
  );
  return gitAvailable;
}

function normalise(p: string): string {
  const r = resolve(p).replace(/[\\/]+$/, '');
  const slashed = r.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

export function samePath(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    let w: Worktree | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        w = {
          path: resolve(line.slice('worktree '.length)),
          branch: null,
          head: '',
          isMain: list.length === 0,
          locked: false,
          prunable: false,
        };
      } else if (!w) continue;
      else if (line.startsWith('HEAD ')) w.head = line.slice(5, 12);
      else if (line.startsWith('branch ')) w.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'locked' || line.startsWith('locked ')) w.locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) w.prunable = true;
    }
    if (w) list.push(w);
  }
  return list;
}

/** The worktrees of the repository a folder belongs to, or null when it is in none (or git is missing). */
export async function worktreesOf(folder: string): Promise<WorktreeListing | null> {
  try {
    const top = (await runGit(['rev-parse', '--show-toplevel'], folder)).trim();
    const worktrees = parseWorktrees(await runGit(['worktree', 'list', '--porcelain'], folder));
    if (worktrees.length === 0) return null;
    return { current: resolve(top), worktrees };
  } catch {
    return null;
  }
}

function gitDirOf(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    return isAbsolute(m[1]!) ? m[1]! : resolve(worktreePath, m[1]!);
  } catch {
    return null;
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function resolveRef(gitDir: string, ref: string): string {
  const direct = readIfExists(join(gitDir, ref));
  if (direct !== null) return direct.trim().slice(0, 7);
  // A linked worktree keeps its refs in the common directory.
  const common = readIfExists(join(gitDir, 'commondir'));
  const commonDir = common ? resolve(gitDir, common.trim()) : gitDir;
  if (commonDir !== gitDir) {
    const shared = readIfExists(join(commonDir, ref));
    if (shared !== null) return shared.trim().slice(0, 7);
  }
  const packed = readIfExists(join(commonDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split(/\r?\n/)) {
      const m = /^([0-9a-f]{40,64}) (.+)$/.exec(line);
      if (m && m[2] === ref) return m[1]!.slice(0, 7);
    }
  }
  return '';
}

/** What a worktree has checked out, read from files only, so it is cheap enough to call often. */
export function headOf(worktreePath: string): { branch: string | null; head: string } | null {
  const gitDir = gitDirOf(worktreePath);
  if (!gitDir || !existsSync(gitDir)) return null;
  const text = readIfExists(join(gitDir, 'HEAD'))?.trim();
  if (!text) return null;
  const m = /^ref:\s*(.+)$/.exec(text);
  if (m) {
    const ref = m[1]!.trim();
    return { branch: ref.replace(/^refs\/heads\//, ''), head: resolveRef(gitDir, ref) };
  }
  return { branch: null, head: text.slice(0, 7) };
}

/** Whether a worktree has uncommitted changes, and how many commits only a detached HEAD holds. */
export async function worktreeStatus(
  worktreePath: string,
): Promise<{ dirty: boolean; unreachable: number }> {
  const dirty = (await runGit(['status', '--porcelain'], worktreePath)).trim().length > 0;
  let unreachable = 0;
  if (headOf(worktreePath)?.branch === null) {
    const n = await runGit(
      ['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes'],
      worktreePath,
    );
    unreachable = Number.parseInt(n.trim(), 10) || 0;
  }
  return { dirty, unreachable };
}

/** The local branches of the repository a folder belongs to; empty outside one. */
export async function branches(folder: string): Promise<string[]> {
  try {
    const out = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], folder);
    return out.split(/\r?\n/).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function refuseDash(label: string, value: string): void {
  if (value.startsWith('-')) throw new GitRefusal(`${label} must not start with "-"`);
}

/** Returns the name when git accepts it as a branch name; throws GitError otherwise. */
export async function validateBranch(folder: string, name: string): Promise<string> {
  if (name.length === 0) throw new GitRefusal('Branch name is empty');
  refuseDash('Branch name', name);
  await runGit(['check-ref-format', '--branch', name], folder);
  return name;
}

async function listingOf(repo: string): Promise<WorktreeListing> {
  const listing = await worktreesOf(repo);
  if (!listing) throw new GitRefusal('Not a git repository');
  return listing;
}

export async function createWorktree(
  repo: string,
  o: { path: string; branch: string; newBranch: boolean; base?: string },
): Promise<WorktreeListing> {
  if (!isAbsolute(o.path)) throw new GitRefusal('The worktree path must be absolute');
  refuseDash('Path', o.path);
  await validateBranch(repo, o.branch);
  const base = o.base ?? 'HEAD';
  refuseDash('Base', base);
  if (existsSync(o.path)) {
    let entries: string[];
    try {
      entries = readdirSync(o.path);
    } catch {
      throw new GitRefusal('The worktree path exists and is not a folder');
    }
    if (entries.length > 0) throw new GitRefusal('The worktree folder already exists and is not empty');
  }
  const args = o.newBranch
    ? ['worktree', 'add', '-b', o.branch, '--', o.path, base]
    : ['worktree', 'add', '--', o.path, o.branch];
  await runGit(args, repo);
  return listingOf(repo);
}

export async function removeWorktree(
  repo: string,
  path: string,
  o: { force: boolean; deleteBranch: boolean },
): Promise<{ listing: WorktreeListing; warning: string | null }> {
  refuseDash('Path', path);
  const target = (await listingOf(repo)).worktrees.find((w) => samePath(w.path, path));
  if (!target) throw new GitRefusal('Not a worktree of this repository');
  if (target.isMain) throw new GitRefusal('The main worktree cannot be removed');
  if (target.prunable) await runGit(['worktree', 'prune'], repo);
  else await runGit(['worktree', 'remove', ...(o.force ? ['--force'] : []), '--', target.path], repo);
  let warning: string | null = null;
  if (o.deleteBranch && target.branch) {
    try {
      await runGit(['branch', '-d', '--', target.branch], repo);
    } catch (e) {
      warning = e instanceof Error ? e.message : String(e);
    }
  }
  return { listing: await listingOf(repo), warning };
}

export async function switchBranch(
  worktreePath: string,
  o: { branch: string; create: boolean },
): Promise<void> {
  await validateBranch(worktreePath, o.branch);
  await runGit(['switch', ...(o.create ? ['-c'] : []), o.branch], worktreePath);
}

export function defaultWorktreeFolder(mainWorktree: string, branch: string): string {
  return resolve(`${dirname(mainWorktree)}/${basename(mainWorktree)}-${branch.replaceAll('/', '-')}`);
}
