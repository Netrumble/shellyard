import type { SessionGit, SessionInfo } from '../shared/types.js';

/** The last segment of a folder path, whichever separator it uses. */
export function worktreeName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The chip on a session tile: branch (or short head when detached) and the worktree's folder name. */
export function chipText(git: SessionGit): string {
  return `⎇ ${git.branch ?? git.head} · ${worktreeName(git.worktree)}`;
}

function normalise(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed;
}

/** Whether two folder paths are the same, ignoring separator style and trailing slash (and case for drive paths). */
export function samePathWeb(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  const drive = /^[a-zA-Z]:/;
  return drive.test(x) || drive.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The sessions still running in a worktree, optionally leaving one out. */
export function sessionsIn(sessions: SessionInfo[], worktree: string, exceptId?: string): SessionInfo[] {
  return sessions.filter((s) => s.status !== 'exited' && s.id !== exceptId && s.git !== null && samePathWeb(s.git.worktree, worktree));
}

/** Where a new worktree goes by default: beside the main one, named `<folder>-<branch>`. Keeps the separator style given. */
export function suggestedFolder(mainWorktree: string, branch: string): string {
  return `${mainWorktree.replace(/[\\/]+$/, '')}-${branch.replaceAll('/', '-')}`;
}
