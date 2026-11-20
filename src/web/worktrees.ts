import type { SessionGit, SessionInfo, Worktree, WorktreeListing } from '../shared/types.js';

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

/** The worktrees a session can move to: every listed one but the one it is in, and none that git would prune. */
export function moveTargets(listing: WorktreeListing | null, current: string): Worktree[] {
  return (listing?.worktrees ?? []).filter((w) => !w.prunable && !samePathWeb(w.path, current));
}

/** The branches no worktree has checked out, which git lets a new worktree use. */
export function freeBranches(branches: string[], listing: WorktreeListing | null): string[] {
  const taken = new Set((listing?.worktrees ?? []).map((w) => w.branch).filter((b): b is string => b !== null));
  return branches.filter((b) => !taken.has(b));
}

/**
 * The questions to ask, in order, before deleting a worktree, and whether git must force it.
 * `status` null means unknown: ask about changes anyway before forcing. A prunable worktree's
 * folder is gone already, so nothing in it can be lost.
 */
export function deleteConfirmations(c: {
  sessionNames: string[];
  path: string;
  prunable: boolean;
  /** No branch checked out: its commits may be held by nothing else. */
  detached: boolean;
  status: { dirty: boolean; unreachable: number } | null;
}): { prompts: string[]; force: boolean } {
  const prompts: string[] = [];
  let force = false;
  if (c.sessionNames.length > 0) prompts.push(`Close ${c.sessionNames.join(', ')} and delete?`);
  if (!c.prunable && c.status === null) {
    // Unknown: say so, and since removal also drops the worktree's HEAD history, warn about
    // commits that only a detached HEAD holds.
    prompts.push(`Could not read the status of ${c.path}; any uncommitted changes will be lost.`);
    if (c.detached) prompts.push(`Commits on no branch (if any) in ${c.path} will be lost.`);
    force = true;
  } else if (!c.prunable && c.status) {
    if (c.status.dirty) {
      prompts.push(`Uncommitted changes in ${c.path} will be lost.`);
      force = true;
    }
    if (c.status.unreachable > 0) {
      prompts.push(`${c.status.unreachable} commits on no branch will be lost.`);
      force = true;
    }
  }
  prompts.push(`Delete worktree ${c.path}? Files ignored by git (like .env) are deleted too.`);
  return { prompts, force };
}

/** Whether a session runs in WSL (`--cd`), where moving it to another worktree is not offered. */
export function isWslSession(args: string[] | undefined): boolean {
  return (args ?? []).includes('--cd');
}
