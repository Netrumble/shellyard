import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { sessionsIn, worktreeName } from '../worktrees.js';
import { confirmShared } from './WorktreeChip.js';

/** Switches the branch checked out in a worktree: to an existing one, or to a new one. */
export function BranchDialog({ worktree, onClose }: { worktree: string; onClose: () => void }): React.JSX.Element {
  const { sessions } = useStore();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [existing, setExisting] = useState('');
  const [fresh, setFresh] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .branches(worktree)
      .then((list) => {
        if (!live) return;
        setBranches(list);
        setExisting(list[0] ?? '');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setBranches([]);
        setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [worktree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const branch = (mode === 'new' ? fresh : existing).trim();
    if (!branch) {
      setError(mode === 'new' ? 'Give the new branch a name.' : 'Choose a branch.');
      return;
    }
    if (!confirmShared(sessionsIn(sessions, worktree), `Switch the branch of ${worktreeName(worktree)}`)) return;
    setBusy(true);
    setError(null);
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
