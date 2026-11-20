import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionInfo, WorktreeListing } from '../../shared/types.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { chipText, isWslSession, moveTargets, sessionsIn, worktreeName } from '../worktrees.js';
import { BranchDialog } from './BranchDialog.js';

/** Asks before touching a worktree where other sessions are working too. True when there is none, or the answer is yes. */
export function confirmShared(sessions: SessionInfo[], action: string): boolean {
  if (sessions.length === 0) return true;
  const names = sessions.map((s) => s.name).join(', ');
  return window.confirm(`${action}? These sessions are also working in this worktree: ${names}. Continue anyway?`);
}

const report = (e: unknown): void => window.alert((e as Error).message);

/** Where a session works (branch and worktree) on its header; opens a menu to move it or switch branch. */
export function WorktreeChip({ session }: { session: SessionInfo }): React.JSX.Element | null {
  const { sessions } = useStore();
  const git = session.git;
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<WorktreeListing | null | undefined>(undefined);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [branching, setBranching] = useState(false);
  const worktree = git?.worktree;

  useEffect(() => {
    if (!open || !worktree) return;
    let live = true;
    setListing(undefined);
    api
      .worktrees(worktree)
      .then((l) => live && setListing(l))
      .catch((e: unknown) => {
        if (!live) return;
        setOpen(false);
        report(e);
      });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      live = false;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, worktree]);

  if (!git) return null;

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation();
    const r = button.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 280)) });
    setOpen((o) => !o);
  };

  const move = (target: string): void => {
    setOpen(false);
    if (!confirmShared(sessionsIn(sessions, target, session.id), `Move "${session.name}" to ${worktreeName(target)}`)) return;
    const claude = session.kind === 'claude';
    if (!window.confirm(`Restart "${session.name}" in ${target}? Its process will be stopped.${claude ? ' Claude starts a new conversation.' : ''}`)) return;
    api.moveSessionToWorktree(session.id, target).catch(report);
  };

  const targets = git.worktreeCount > 1 && !isWslSession(session.args) ? moveTargets(listing ?? null, git.worktree) : [];

  return (
    <>
      <button ref={button} type="button" className="model worktree-chip" title={git.worktree} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {chipText(git)}
        {git.isMain && <span className="main-mark"> main</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="worktree-menu"
            role="menu"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {listing === undefined ? (
              <p className="hint">Loading…</p>
            ) : (
              <>
                {targets.length > 0 && <div className="worktree-menu-title">Move to worktree</div>}
                {targets.map((w) => (
                  <button key={w.path} type="button" role="menuitem" title={w.path} onClick={() => move(w.path)}>
                    {`⎇ ${w.branch ?? w.head} · ${worktreeName(w.path)}`}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    setBranching(true);
                  }}
                >
                  Switch branch…
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
      {branching && <BranchDialog worktree={git.worktree} onClose={() => setBranching(false)} />}
    </>
  );
}
