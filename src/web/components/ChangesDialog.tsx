import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileDiff, SessionInfo, WorktreeChanges } from '../../shared/types.js';
import { api } from '../api.js';
import { changeLabel, changeText, parseDiff, splitPath, STATUS_LETTER, STATUS_WORD } from '../diff.js';
import { useEscape } from '../escape.js';
import { useStore } from '../store.js';
import { worktreeName } from '../worktrees.js';

/** Beyond this many lines a diff is cut, so that a huge one does not hold the page up. */
const MAX_ROWS = 10_000;

type DiffState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; diff: FileDiff };

function DiffBody({ state }: { state: DiffState | null }): React.JSX.Element {
  const rows = useMemo(() => (state?.kind === 'ready' ? parseDiff(state.diff.diff) : []), [state]);
  if (!state) return <p className="hint">Choose a file.</p>;
  if (state.kind === 'loading') return <p className="hint">Loading…</p>;
  if (state.kind === 'error') return <p className="error">{state.message}</p>;
  const { diff } = state;
  if (diff.binary) return <p className="hint">A binary file: there are no lines to compare.</p>;
  if (diff.tooLarge) return <p className="hint">This change is too large to show here.</p>;
  if (rows.length === 0) return <p className="hint">{diff.status === 'deleted' || diff.status === 'added' || diff.status === 'untracked' ? 'An empty file.' : 'No changes in the text (only the file mode, perhaps).'}</p>;
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div className="diff" role="table" aria-label={`Changes in ${diff.path}`}>
      {shown.map((r, i) =>
        r.kind === 'hunk' || r.kind === 'note' ? (
          <div key={i} className={`diff-row ${r.kind}`} role="row">
            <span className="diff-code" role="cell">
              {r.text}
            </span>
          </div>
        ) : (
          <div key={i} className={`diff-row ${r.kind}`} role="row">
            <span className="diff-no" role="cell" aria-hidden="true">
              {r.oldNo ?? ''}
            </span>
            <span className="diff-no" role="cell" aria-hidden="true">
              {r.newNo ?? ''}
            </span>
            <span className="diff-code" role="cell">
              <span className="diff-mark" aria-label={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : undefined}>
                {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
              </span>
              {r.text}
            </span>
          </div>
        ),
      )}
      {rows.length > shown.length && <p className="hint">Only the first {MAX_ROWS.toLocaleString()} lines are shown.</p>}
    </div>
  );
}

/**
 * The uncommitted changes of a worktree: the files that are not as the last commit has them, and
 * what changed in the one chosen. It reads them again by itself when the worktree changes.
 */
export function ChangesDialog({ worktree, onClose }: { worktree: string; onClose: () => void }): React.JSX.Element {
  const { changes: summaries } = useStore();
  const [changes, setChanges] = useState<WorktreeChanges | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffState | null>(null);
  // Counts the reads, so that only the answer to the latest one is shown.
  const [version, setVersion] = useState(0);
  const live = useRef(true);
  const list = useRef<HTMLUListElement>(null);
  useEscape(onClose);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    api
      .changes(worktree)
      .then((c) => {
        if (!live.current) return;
        setError(null);
        setChanges(c);
        setVersion((v) => v + 1);
        // Keep the file chosen while it is still changed; else take the first.
        setSelected((s) => (c && s && c.files.some((f) => f.path === s) ? s : (c?.files[0]?.path ?? null)));
      })
      .catch((e: unknown) => {
        if (!live.current) return;
        setError((e as Error).message);
        setChanges((c) => c ?? null);
      });
  }, [worktree]);

  useEffect(load, [load]);

  // When the figures the server keeps for this worktree change, read the files again.
  const summary = summaries[worktree];
  const summaryKey = summary ? `${summary.files}/${summary.added}/${summary.removed}` : 'none';
  const firstKey = useRef(summaryKey);
  useEffect(() => {
    if (firstKey.current === summaryKey) return;
    firstKey.current = summaryKey;
    load();
  }, [summaryKey, load]);

  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let current = true;
    setDiff((d) => (d?.kind === 'ready' && d.diff.path === selected ? d : { kind: 'loading' }));
    api
      .diff(worktree, selected)
      .then((d) => current && setDiff({ kind: 'ready', diff: d }))
      .catch((e: unknown) => current && setDiff({ kind: 'error', message: (e as Error).message }));
    return () => {
      current = false;
    };
  }, [worktree, selected, version]);

  const files = changes?.files ?? [];
  const move = (by: number): void => {
    if (files.length === 0) return;
    const i = files.findIndex((f) => f.path === selected);
    const next = files[Math.max(0, Math.min(files.length - 1, (i < 0 ? 0 : i) + by))]!;
    setSelected(next.path);
    list.current?.querySelector<HTMLButtonElement>(`[data-path="${CSS.escape(next.path)}"]`)?.focus();
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
      <div className="dialog changes-dialog" role="dialog" aria-label={`Uncommitted changes in ${worktreeName(worktree)}`}>
        <header className="changes-head">
          <h2>
            Changes <span className="changes-where" title={worktree}>{worktreeName(worktree)}</span>
          </h2>
          {changes && changes.files.length > 0 && (
            <span className="changes-total" title={changeLabel({ files: changes.files.length, added: changes.added, removed: changes.removed })}>
              {changeText({ files: changes.files.length, added: changes.added, removed: changes.removed })}
            </span>
          )}
          <span className="spacer" />
          <button type="button" onClick={load}>
            Refresh
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="hint changes-note">Not committed, compared with the last commit: everything changed in this worktree, by any session or editor.</p>
        {error && <p className="error">{error}</p>}
        {changes === undefined && !error && <p className="hint">Loading…</p>}
        {changes === null && !error && <p className="hint">This folder is not in a git repository.</p>}
        {changes && changes.files.length === 0 && <p className="hint">Nothing changed since the last commit.</p>}
        {changes && changes.files.length > 0 && (
          <div className="changes-body">
            <ul
              ref={list}
              className="changes-files"
              aria-label="Changed files"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'j') move(1);
                else if (e.key === 'ArrowUp' || e.key === 'k') move(-1);
                else return;
                e.preventDefault();
              }}
            >
              {files.map((f) => {
                const { dir, name } = splitPath(f.path);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      data-path={f.path}
                      className={f.path === selected ? 'selected' : undefined}
                      aria-current={f.path === selected}
                      title={`${f.path} (${STATUS_WORD[f.status]})`}
                      onClick={() => setSelected(f.path)}
                    >
                      <span className={`change-letter ${f.status}`} aria-label={STATUS_WORD[f.status]}>
                        {STATUS_LETTER[f.status]}
                      </span>
                      <span className="change-path">
                        <span className="change-name">{name}</span>
                        {dir && <span className="change-dir">{dir}</span>}
                      </span>
                      <span className="change-count">
                        {f.added === null ? (
                          <span className="hint">bin</span>
                        ) : (
                          <>
                            <span className="plus">+{f.added}</span> <span className="minus">−{f.removed ?? 0}</span>
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
              {changes.truncated && <li className="hint">More files changed than are listed.</li>}
            </ul>
            <div className="changes-diff">
              {selected && <div className="changes-file-title">{selected}</div>}
              <DiffBody state={diff} />
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** "3 files · +42 −7" beside a session's branch; opens its worktree's changes. Absent without any. */
export function ChangesBadge({ session }: { session: SessionInfo }): React.JSX.Element | null {
  const { changes } = useStore();
  const [open, setOpen] = useState(false);
  const worktree = session.git?.worktree;
  const summary = worktree ? changes[worktree] : undefined;
  return (
    <>
      {summary && summary.files > 0 && (
        <button
          type="button"
          className="model changes-chip"
          title={`${changeLabel(summary)}. Click to see them.`}
          aria-label={`${changeLabel(summary)}. Show the changes.`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {summary.files} {summary.files === 1 ? 'file' : 'files'} <span className="plus">+{summary.added}</span> <span className="minus">−{summary.removed}</span>
        </button>
      )}
      {open && worktree && <ChangesDialog worktree={worktree} onClose={() => setOpen(false)} />}
    </>
  );
}
