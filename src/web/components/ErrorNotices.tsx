import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ErrorReport } from '../../shared/types.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { reportPageError } from '../page-errors.js';
import { useStore } from '../store.js';

/** How many notices are shown at once; the others are in Recent errors. */
const MAX_SHOWN = 3;

const SOURCE: Record<ErrorReport['source'], string> = {
  server: 'ShellYard hit an error',
  page: 'The page hit an error',
  startup: 'ShellYard did not start',
};

/** Copies a text; true when the clipboard took it. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The file of a report, with buttons to copy its path and show it in the file manager. */
function ReportFile({ report }: { report: { id: string | null; file: string } }): React.JSX.Element {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="error-file">
      <code title={report.file}>{report.file}</code>
      <span className="error-file-actions">
        <button type="button" onClick={() => void copy(report.file).then((ok) => setSaid(ok ? 'Copied' : 'Select the path and copy it'))}>
          Copy path
        </button>
        {report.id && (
          <button
            type="button"
            onClick={() => {
              setSaid(null);
              api.revealError(report.id!).catch((e: unknown) => setSaid((e as Error).message));
            }}
          >
            Show in folder
          </button>
        )}
        {said && (
          <span className="hint" role="status">
            {said}
          </span>
        )}
      </span>
    </div>
  );
}

/** The errors not seen yet, as notices at the foot of the page, each with where its report is. */
export function ErrorNotices({ onShowAll }: { onShowAll: () => void }): React.JSX.Element | null {
  const { errors } = useStore();
  const unseen = errors.filter((r) => !r.seen);
  if (unseen.length === 0) return null;
  const shown = unseen.slice(0, MAX_SHOWN);
  return (
    <div className="error-notices" role="region" aria-label="Errors">
      {shown.map((r) => (
        <div key={r.id} className="error-notice" role="alert">
          <div className="error-notice-head">
            <strong>{SOURCE[r.source]}</strong>
            {r.count > 1 && <span className="error-count">×{r.count}</span>}
            <span className="spacer" />
            <button type="button" className="icon" aria-label="Dismiss this error" title="Dismiss" onClick={() => void api.errorSeen(r.id).catch(() => undefined)}>
              ✕
            </button>
          </div>
          <p className="error-message">{r.message}</p>
          {r.context && <p className="hint error-context">{r.context}</p>}
          <ReportFile report={r} />
        </div>
      ))}
      {unseen.length > shown.length && (
        <div className="error-more">
          <button type="button" className="ny-link" onClick={onShowAll}>
            {unseen.length - shown.length} more…
          </button>
          <button type="button" className="ny-link" onClick={() => void api.errorsSeen().catch(() => undefined)}>
            Dismiss all
          </button>
        </div>
      )}
    </div>
  );
}

/** Every error of this run of the server, newest first, each with its report file. */
export function RecentErrorsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { errors } = useStore();
  useEscape(onClose);
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
      <div className="dialog wide" role="dialog" aria-label="Recent errors">
        <h2>Recent errors</h2>
        <p className="hint">Each error is written to a file of its own, with what is needed to understand it and no secrets. Attach it to an issue if you report one.</p>
        {errors.length === 0 ? (
          <p className="hint">No errors since ShellYard started.</p>
        ) : (
          <ul className="error-list">
            {errors.map((r) => (
              <li key={r.id}>
                <div className="error-notice-head">
                  <strong>{SOURCE[r.source]}</strong>
                  {r.count > 1 && <span className="error-count">×{r.count}</span>}
                  <span className="spacer" />
                  <span className="hint">{new Date(r.lastAt).toLocaleString()}</span>
                </div>
                <p className="error-message">{r.message}</p>
                {r.context && <p className="hint error-context">{r.context}</p>}
                <ReportFile report={r} />
              </li>
            ))}
          </ul>
        )}
        <div className="dialog-buttons">
          {errors.some((r) => !r.seen) && (
            <button type="button" onClick={() => void api.errorsSeen().catch(() => undefined)}>
              Dismiss all notices
            </button>
          )}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface BoundaryState {
  error: Error | null;
  /** Undefined while the report is on its way; null when none could be written. */
  report: ErrorReport | null | undefined;
}

/**
 * Catches an error that breaks the drawing of the page, which would otherwise leave it blank:
 * shows what happened and where the report is, and offers to reload.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, report: undefined };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error, report: undefined };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = [error.stack ?? '', info.componentStack ? `Components:${info.componentStack}` : ''].filter(Boolean).join('\n\n');
    const withStack = Object.assign(new Error(error.message), { name: error.name, stack });
    void reportPageError(withStack, 'page: drawing the page').then((report) => this.setState({ report }));
  }

  render(): ReactNode {
    const { error, report } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="down page-crash">
        <h1>The page hit an error</h1>
        <p className="error-message">{`${error.name}: ${error.message}`}</p>
        {report === undefined && <p className="hint">Writing the error report…</p>}
        {report === null && <p className="hint">No report was written: ShellYard may not be running, or the same error was reported a moment ago.</p>}
        {report && (
          <>
            <p>The details are in this file:</p>
            <ReportFile report={report} />
          </>
        )}
        <p className="hint">Your sessions are still running: reloading the page brings them back.</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}
