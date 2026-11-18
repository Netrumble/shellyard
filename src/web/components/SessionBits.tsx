import { useEffect, useState } from 'react';
import type { SessionInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { elapsedLabel } from '../attention.js';
import { statusLabel, statusTone } from '../selectors.js';
import { useStore } from '../store.js';

export function StatusBadge({ session }: { session: SessionInfo }): React.JSX.Element {
  return <span className={`status tone-${statusTone(session)}`}>{statusLabel(session)}</span>;
}

export function ColorDot({ color }: { color: string }): React.JSX.Element {
  return <span className="dot" style={{ background: color }} aria-hidden="true" />;
}

/** "for 4 min", recomputed every second. */
export function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="elapsed">for {elapsedLabel(now - since)}</span>;
}

/** Shows which story a session is in, and moves it to another one or to none. */
export function StorySelect({ session }: { session: SessionInfo }): React.JSX.Element | null {
  const { stories } = useStore();
  if (stories.length === 0) return null;
  const current = stories.some((s) => s.id === session.storyId) ? (session.storyId ?? '') : '';
  return (
    <select
      className="story-select"
      value={current}
      aria-label={`Area of ${session.name}`}
      title="Area"
      onChange={(e) => api.moveSession(session.id, e.target.value || null).catch((err: unknown) => window.alert((err as Error).message))}
    >
      <option value="">No area</option>
      {stories.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

/** A filter over stories: everything, one story, or the sessions with no story. */
export function StoryFilter({ value, onChange }: { value: string | null | undefined; onChange: (v: string | null | undefined) => void }): React.JSX.Element | null {
  const { stories } = useStore();
  if (stories.length === 0) return null;
  const ALL = '__all__';
  const NONE = '__none__';
  return (
    <label className="story-filter">
      <span>Area</span>
      <select
        value={value === undefined ? ALL : value === null ? NONE : value}
        onChange={(e) => onChange(e.target.value === ALL ? undefined : e.target.value === NONE ? null : e.target.value)}
      >
        <option value={ALL}>All</option>
        {stories.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NONE}>No area</option>
      </select>
    </label>
  );
}

/** Rename, recolour and close: the same three actions wherever a session is shown. */
/** The mark of VS Code, drawn plainly in the colour of the text around it. */
function CodeIcon(): React.JSX.Element {
  return (
    <svg className="code-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M17 2.5 21.5 4.6v14.8L17 21.5 7.2 12.6l-3.6 2.8-1.6-.9v-5l1.6-.9 3.6 2.8L17 2.5Zm0 5.4-5.3 4.1 5.3 4.1V7.9Z" fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

/** `onMinimize`, where given, adds a "_" before the close button that leaves the terminal for the board. */
export function SessionActions({ session, onMinimize }: { session: SessionInfo; onMinimize?: () => void }): React.JSX.Element {
  const report = (e: unknown): void => window.alert((e as Error).message);
  const rename = (): void => {
    const name = window.prompt('Session name', session.name);
    if (name && name.trim()) api.updateSession(session.id, { name }).catch(report);
  };
  const close = (): void => {
    const running = session.status !== 'exited';
    if (running && !window.confirm(`Close "${session.name}"? Its process will be stopped.`)) return;
    api.deleteSession(session.id).catch(report);
  };
  return (
    <span className="actions">
      {!session.error && (
        <button
          type="button"
          className="icon"
          title={`Open VS Code in ${session.cwd}`}
          aria-label={`Open VS Code in the folder of ${session.name}`}
          onClick={() => api.openEditor(session.id).catch(report)}
        >
          <CodeIcon />
        </button>
      )}
      <button type="button" className="icon" title="Rename" aria-label={`Rename ${session.name}`} onClick={rename}>
        ✎
      </button>
      <label className="icon color-pick" title="Colour">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(session.color) ? session.color : '#888888'}
          aria-label={`Colour of ${session.name}`}
          onChange={(e) => api.updateSession(session.id, { color: e.target.value }).catch(report)}
        />
      </label>
      {onMinimize && (
        <button type="button" className="icon" title="Back to the board" aria-label={`Leave ${session.name} and go back to the board`} onClick={onMinimize}>
          _
        </button>
      )}
      <button type="button" className="icon" title="Close" aria-label={`Close ${session.name}`} onClick={close}>
        ✕
      </button>
    </span>
  );
}
