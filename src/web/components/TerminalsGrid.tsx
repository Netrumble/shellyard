import type { SessionInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { reasonLabel } from '../attention.js';
import { inStory } from '../selectors.js';
import { setView, useStore } from '../store.js';
import { Tachometer } from './Cluster.js';
import { ColorDot, Elapsed, SessionActions, StatusBadge, StoryFilter, StorySelect } from './SessionBits.js';
import { BackgroundButton } from './BackgroundEditor.js';
import { WorktreeChip } from './WorktreeChip.js';
import { ChangesBadge } from './ChangesDialog.js';
import { TerminalView } from './TerminalView.js';
import { dragSource } from './drag-target.js';
import { SESSION_DRAG } from '../drag.js';
import { detach, reattach, showDetached, useDetached } from '../detached.js';

/** What stands in for the terminal of a session shown in a window of its own. */
function DetachedPlaceholder({ session }: { session: SessionInfo }): React.JSX.Element {
  return (
    <div className="detached-placeholder" role="status">
      <strong>{session.name} is open in a window of its own.</strong>
      <span className="detached-actions">
        <button type="button" onClick={() => showDetached(session.id)}>
          Show window
        </button>
        <button type="button" onClick={() => reattach(session.id)}>
          Bring back
        </button>
      </span>
    </div>
  );
}

/** Opens a session in a window of its own; says so when the browser blocked the window. */
export function detachOrWarn(id: string): void {
  if (!detach(id)) window.alert('The browser blocked the new window. Allow pop-ups for this page to open sessions in windows of their own.');
}

/**
 * The terminal of a session; what stands in for it when the session never started, or when it
 * is shown in a window of its own (`inOwnWindow` is that window, which always draws it).
 */
export function SessionBody({ session, autoFocus, onFocusChange, inOwnWindow }: { session: SessionInfo; autoFocus?: boolean; onFocusChange?: (focused: boolean) => void; inOwnWindow?: boolean }): React.JSX.Element {
  const detached = useDetached();
  if (!inOwnWindow && detached.has(session.id)) return <DetachedPlaceholder session={session} />;
  if (session.error) {
    return (
      <div className="session-error" role="alert">
        <strong>This session could not start.</strong>
        <span>{session.error}</span>
      </div>
    );
  }
  return <TerminalView sessionId={session.id} autoFocus={autoFocus} onFocusChange={onFocusChange} background={session.background} font={session.font} size={{ cols: session.cols, rows: session.rows }} />;
}

/**
 * The header of a terminal. `inOwnWindow` is the header of a detached session's window: it has no
 * Detach button and its name is not dragged, and "_" brings the session back instead.
 */
export function TileHeader({ session, children, inOwnWindow }: { session: SessionInfo; children?: React.ReactNode; inOwnWindow?: boolean }): React.JSX.Element {
  const detached = useDetached().has(session.id);
  return (
    <header className="tile-header" style={{ borderTopColor: session.color }}>
      <ColorDot color={session.color} />
      {inOwnWindow ? (
        <span className="session-name">{session.name}</span>
      ) : (
        <span className="session-name drag-handle" title="Drag to an area, or out of the window to open it in a window of its own" {...dragSource(SESSION_DRAG, session.id)}>
          {session.name}
        </span>
      )}
      {session.model && <span className="model">{session.model}</span>}
      <WorktreeChip session={session} />
      <ChangesBadge session={session} />
      {session.status !== 'exited' && <Tachometer sessionId={session.id} />}
      <StatusBadge session={session} />
      {session.status === 'exited' && session.exitCode !== null && <span className="hint">exit code {session.exitCode}</span>}
      <span className="spacer" />
      {children}
      <StorySelect session={session} />
      <BackgroundButton session={session} />
      {!inOwnWindow && !detached && (
        <button type="button" className="icon" title="Open in a window of its own" aria-label={`Open ${session.name} in a window of its own`} onClick={() => detachOrWarn(session.id)}>
          ⧉
        </button>
      )}
      <SessionActions session={session} onMinimize={inOwnWindow ? undefined : () => setView({ kind: 'board' })} />
    </header>
  );
}

/** Every session side by side, or only those of one story. */
export function TerminalsGrid({ storyFilter }: { storyFilter?: string | null }): React.JSX.Element {
  const { sessions, stories, loaded } = useStore();
  const shown = inStory(sessions, storyFilter, stories);
  return (
    <div className="grid-view">
      <div className="view-tools">
        <StoryFilter value={storyFilter} onChange={(v) => setView({ kind: 'grid', storyFilter: v })} />
      </div>
      {loaded && shown.length === 0 ? (
        <p className="empty">
          {sessions.length === 0 ? 'No sessions are open. Start one from the sidebar.' : 'This area has no sessions. Start one with the + beside its name.'}
        </p>
      ) : (
        <div className="grid">
          {shown.map((s) => (
            <section key={s.id} className="tile">
              <TileHeader session={s}>
                <button type="button" className="icon" title="Maximise" aria-label={`Maximise ${s.name}`} onClick={() => setView({ kind: 'single', id: s.id })}>
                  ⤢
                </button>
              </TileHeader>
              <SessionBody session={s} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** One session filling the main area. */
export function SingleTerminal({ id }: { id: string }): React.JSX.Element {
  const { sessions } = useStore();
  const session = sessions.find((s) => s.id === id);
  if (!session) return <p className="empty">This session no longer exists.</p>;
  return (
    <section className="tile single">
      <TileHeader session={session}>
        <span className="hint">
          {reasonLabel(session)} <Elapsed since={session.statusSince} />
        </span>
        {session.status === 'attention' && session.reason === 'finished' && (
          <button type="button" onClick={() => void api.ackSession(session.id).catch(() => undefined)}>
            Mark as seen
          </button>
        )}
        <button type="button" onClick={() => setView({ kind: 'grid' })}>
          Back to grid
        </button>
      </TileHeader>
      <SessionBody session={session} autoFocus />
    </section>
  );
}
