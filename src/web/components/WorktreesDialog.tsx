import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Worktree, WorktreeListing } from '../../shared/types.js';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { countOf, deleteConfirmations, freeBranches, samePathWeb, sessionsIn, suggestedFolder, worktreeName } from '../worktrees.js';
import { useEscape } from '../escape.js';
import { BranchDialog } from './BranchDialog.js';
import { FolderPicker } from './FolderPicker.js';

type Status = { dirty: boolean; unreachable: number } | 'unknown';

/** The worktrees of the repository a folder is in: list them, add one, delete one, switch the branch of one. */
export function WorktreesDialog({ folder, onClose, onCreated }: { folder: string; onClose: () => void; onCreated?: (path: string) => void }): React.JSX.Element {
  const { sessions } = useStore();
  const [listing, setListing] = useState<WorktreeListing | null | undefined>(undefined);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [branches, setBranches] = useState<string[] | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<Record<string, boolean>>({});
  const [branching, setBranching] = useState<Worktree | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // The new worktree form.
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [fresh, setFresh] = useState('');
  const [existing, setExisting] = useState('');
  const [base, setBase] = useState('');
  const [path, setPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const loadBranches = useCallback((): void => {
    api
      .branches(folder)
      .then((list) => live.current && setBranches(list))
      .catch(() => live.current && setBranches([]));
  }, [folder]);

  const refresh = useCallback((): void => {
    api
      .worktrees(folder)
      .then((l) => live.current && setListing(l))
      .catch((e: unknown) => {
        if (!live.current) return;
        setListing(null);
        setError((e as Error).message);
      });
    loadBranches();
  }, [folder, loadBranches]);

  useEffect(refresh, [refresh]);

  // The "changes" mark of each row, loaded once the rows are known (and again when they change).
  useEffect(() => {
    if (!listing) return;
    let current = true;
    setStatuses({});
    for (const w of listing.worktrees) {
      // A bare repository has no files checked out: nothing to report.
      if (w.prunable || w.bare) continue;
      api
        .worktreeStatus(w.path)
        .then((s): Status => s)
        .catch((): Status => 'unknown')
        .then((s) => current && setStatuses((all) => ({ ...all, [w.path]: s })));
    }
    return () => {
      current = false;
    };
  }, [listing]);

  // Escape while Switch branch is open closes that one only: it is newer on the stack.
  useEscape(onClose);

  const worktrees = listing?.worktrees ?? [];
  const main = worktrees.find((w) => w.isMain) ?? worktrees[0];
  const current = worktrees.find((w) => listing && samePathWeb(w.path, listing.current)) ?? main;
  const free = freeBranches(branches ?? [], listing ?? null);
  const chosenExisting = free.includes(existing) ? existing : (free[0] ?? '');
  const defaultBase = current ? (current.branch ?? current.head) : '';
  const chosenBase = base || defaultBase;
  const branchName = (mode === 'new' ? fresh : chosenExisting).trim();
  const suggested = main && branchName ? suggestedFolder(main.path, branchName, main.bare) : '';
  const target = pathEdited ? path : suggested;

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!main) return;
    if (!branchName) {
      setFormError(mode === 'new' ? 'Give the new branch a name.' : 'Choose a branch.');
      return;
    }
    const where = target.trim();
    if (!where) {
      setFormError('Choose a folder for the worktree.');
      return;
    }
    const newBranch = mode === 'new';
    setBusy(true);
    setFormError(null);
    setWarning(null);
    try {
      const l = await api.createWorktree({ repo: main.path, path: where, branch: branchName, newBranch, ...(newBranch && chosenBase ? { base: chosenBase } : {}) });
      if (!live.current) return;
      setListing(l);
      setFresh('');
      setPath('');
      setPathEdited(false);
      loadBranches();
      onCreated?.(where);
    } catch (err) {
      if (live.current) setFormError((err as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const remove = async (w: Worktree): Promise<void> => {
    if (!main) return;
    setError(null);
    setWarning(null);
    const open = sessionsIn(sessions, w.path);
    // Asked fresh, as files may have changed since the list was shown; a failure counts as unknown.
    setBusy(true);
    const status = w.prunable ? null : await api.worktreeStatus(w.path).catch(() => null);
    const { prompts, force } = deleteConfirmations({ sessionNames: open.map((s) => s.name), path: w.path, prunable: w.prunable, detached: w.branch === null, status });
    // Every question first: a "no" to any of them leaves everything as it was.
    for (const p of prompts) {
      if (!window.confirm(p)) {
        if (live.current) setBusy(false);
        return;
      }
    }
    try {
      for (const s of open) await api.deleteSession(s.id);
      const result = await api.removeWorktree({ repo: main.path, path: w.path, force, deleteBranch: w.branch !== null && deleteBranch[w.path] === true });
      if (!live.current) {
        // Closed meanwhile (it was opened from a session that was in this worktree): say it here.
        if (result.warning) window.alert(result.warning);
        return;
      }
      setListing(result.listing);
      setWarning(result.warning);
      loadBranches();
    } catch (err) {
      if (live.current) setError((err as Error).message);
      else window.alert((err as Error).message);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const mark = (w: Worktree): React.JSX.Element | null => {
    const s = statuses[w.path];
    if (w.prunable || s === undefined) return null;
    if (s === 'unknown') return <span className="worktree-mark" title="Could not read the status of this worktree">status unknown</span>;
    return (
      <>
        {s.dirty && <span className="worktree-mark warn">changes</span>}
        {s.unreachable > 0 && <span className="worktree-mark warn">{`${countOf(s.unreachable, 'commit', 'commits')} on no branch`}</span>}
      </>
    );
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
      <div className="dialog wide" role="dialog" aria-label="Worktrees">
        <h2>Worktrees</h2>
        {listing === undefined && <p className="hint">Loading…</p>}
        {listing === null && !error && <p className="hint">This folder is not in a git repository.</p>}
        {worktrees.length > 0 && (
          <ul className="worktree-list">
            {worktrees.map((w) => {
              const names = sessionsIn(sessions, w.path).map((s) => s.name);
              return (
                <li key={w.path} className="worktree-row">
                  <div className="worktree-info">
                    <span className="worktree-branch">{`⎇ ${w.branch ?? w.head}`}</span>
                    <span className="worktree-name" title={w.path}>
                      {worktreeName(w.path)}
                    </span>
                    {w.isMain && <span className="worktree-mark ok">main</span>}
                    {w.bare && <span className="worktree-mark">bare</span>}
                    {w.locked && <span className="worktree-mark">locked</span>}
                    {w.prunable && <span className="worktree-mark">prunable</span>}
                    {mark(w)}
                  </div>
                  {names.length > 0 && <div className="hint">{`Sessions: ${names.join(', ')}`}</div>}
                  <div className="worktree-actions">
                    {!w.isMain && w.branch && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={deleteBranch[w.path] === true}
                          onChange={(e) => setDeleteBranch((all) => ({ ...all, [w.path]: e.target.checked }))}
                        />
                        <span>{`Also delete the branch ${w.branch}`}</span>
                      </label>
                    )}
                    <span className="spacer" />
                    {!w.prunable && !w.bare && (
                      <button type="button" disabled={busy} onClick={() => setBranching(w)}>
                        Switch branch
                      </button>
                    )}
                    {!w.isMain && !w.bare && (
                      <button
                        type="button"
                        className="danger"
                        disabled={busy || w.locked}
                        title={w.locked ? 'Locked worktrees cannot be deleted here' : undefined}
                        onClick={() => void remove(w)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {warning && (
          <p className="worktree-warning" role="status">
            {warning}
          </p>
        )}

        {main && (
          <form className="worktree-form" onSubmit={(e) => void create(e)} aria-label="New worktree">
            <h3>New worktree</h3>
            <label className="check">
              <input type="radio" name="worktree-branch-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
              <span>New branch</span>
            </label>
            {mode === 'new' && (
              <>
                <label>
                  <span>Branch</span>
                  <input value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="feature/name" spellCheck={false} />
                </label>
                <label>
                  <span>From</span>
                  <select value={chosenBase} onChange={(e) => setBase(e.target.value)} disabled={branches === null}>
                    {current && current.branch === null && <option value={current.head}>{`${current.head} (detached)`}</option>}
                    {(branches ?? []).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="check">
              <input type="radio" name="worktree-branch-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
              <span>Existing branch</span>
            </label>
            {mode === 'existing' && (
              <label>
                <span>Branch</span>
                <select value={chosenExisting} onChange={(e) => setExisting(e.target.value)} disabled={branches === null}>
                  {branches === null && <option>Loading…</option>}
                  {branches !== null && free.length === 0 && <option value="">Every branch is checked out already</option>}
                  {free.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="field">
              <span id="worktree-folder-label">Folder</span>
              <FolderPicker
                value={target}
                onChange={(p) => {
                  setPath(p);
                  // Emptied: back to following the branch name.
                  setPathEdited(p !== '');
                }}
                placeholder="Beside the main worktree"
                labelledBy="worktree-folder-label"
              />
            </div>
            {formError && (
              <p className="error" role="alert">
                {formError}
              </p>
            )}
            <div className="dialog-buttons">
              <button type="submit" className="primary" disabled={busy}>
                Create worktree
              </button>
            </div>
          </form>
        )}

        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {branching && (
        <BranchDialog
          worktree={branching.path}
          current={branching.branch}
          onClose={() => {
            setBranching(null);
            refresh();
          }}
        />
      )}
    </div>,
    document.body,
  );
}
