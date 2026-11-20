import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { leaveDetachedPrompt, sessionsIn, worktreeName } from '../worktrees.js';
import { useEscape } from '../escape.js';
import { confirmShared } from './WorktreeChip.js';

/**
 * Switches the branch checked out in a worktree: to an existing one, or to a new one.
 * `current` is the branch checked out now (left out of the choices); `exceptId` a session
 * not to count among the others working there.
 */
export function BranchDialog({
  worktree,
  current,
  exceptId,
  onClose,
}: {
  worktree: string;
  current?: string | null;
  exceptId?: string;
  onClose: () => void;
}): React.JSX.Element {
  const { sessions } = useStore();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [existing, setExisting] = useState('');
  const [fresh, setFresh] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .branches(worktree)
      .then((list) => {
        if (!live) return;
        const others = list.filter((b) => b !== current);
        setBranches(others);
        setExisting(others[0] ?? '');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setBranches([]);
        setLoadError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [worktree, current]);

  useEscape(onClose);

  /** Detached: asks before leaving behind commits that no branch holds. True to go on. */
  const confirmLeavingDetached = async (): Promise<boolean> => {
    if (current !== null) return true;
    let unreachable: number | null = null;
    try {
      unreachable = (await api.worktreeStatus(worktree)).unreachable;
    } catch {
      unreachable = null;
    }
    if (unreachable === null) return window.confirm('Could not tell whether commits on no branch would be left behind (recoverable only from the reflog). Continue?');
    const prompt = leaveDetachedPrompt(unreachable);
    return prompt === null || window.confirm(prompt);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const branch = (mode === 'new' ? fresh : existing).trim();
    if (!branch) {
      // The reason the list is empty stays on screen; no need to say "choose" over it.
      if (mode === 'existing' && loadError) return;
      setError(mode === 'new' ? 'Give the new branch a name.' : 'Choose a branch.');
      return;
    }
    if (!confirmShared(sessionsIn(sessions, worktree, exceptId), `Switch the branch of ${worktreeName(worktree)}`)) return;
    setBusy(true);
    setError(null);
    if (!(await confirmLeavingDetached())) {
      setBusy(false);
      return;
    }
    try {
      await api.switchBranch({ path: worktree, branch, create: mode === 'new' });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="overlay"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="dialog" onSubmit={(e) => void submit(e)} aria-label="Switch branch">
        <h2>Switch branch</h2>
        <p className="hint" title={worktree}>
          In {worktreeName(worktree)}
        </p>
        <label className="check">
          <input type="radio" name="branch-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
          <span>Existing branch</span>
        </label>
        {mode === 'existing' && (
          <select value={existing} onChange={(e) => setExisting(e.target.value)} aria-label="Branch" disabled={branches === null}>
            {branches === null && <option>Loading…</option>}
            {branches?.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="radio" name="branch-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
          <span>New branch</span>
        </label>
        {mode === 'new' && <input value={fresh} onChange={(e) => setFresh(e.target.value)} aria-label="New branch name" placeholder="feature/name" autoFocus />}
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || branches === null}>
            Switch
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
