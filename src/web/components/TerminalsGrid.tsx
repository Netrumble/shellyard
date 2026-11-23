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

/** What stands in for a terminal when the session never started. */
export function SessionBody({ session, autoFocus, onFocusChange }: { session: SessionInfo; autoFocus?: boolean; onFocusChange?: (focused: boolean) => void }): React.JSX.Element {
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

function TileHeader({ session, children }: { session: SessionInfo; children?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="tile-header" style={{ borderTopColor: session.color }}>
      <ColorDot color={session.color} />
      <span className="session-name">{session.name}</span>
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
      <SessionActions session={session} onMinimize={() => setView({ kind: 'board' })} />
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
