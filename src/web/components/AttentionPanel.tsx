import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { reasonLabel, visibleCards } from '../attention.js';
import { inStory, selectAttention, statusTone } from '../selectors.js';
import { setView, useStore } from '../store.js';
import { Tachometer } from './Cluster.js';
import { ColorDot, Elapsed, SessionActions, StatusBadge, StoryFilter, StorySelect } from './SessionBits.js';
import { BackgroundButton } from './BackgroundEditor.js';
import { SessionBody } from './TerminalsGrid.js';

const RELEASE_DELAY_MS = 400;

function Card({ session, onFocusChange }: { session: SessionInfo; onFocusChange: (focused: boolean) => void }): React.JSX.Element {
  const waiting = session.status === 'attention';
  return (
    <section className={`card tone-border-${statusTone(session)}`}>
      <header className="card-header">
        {/* The chequered flag passes once over the header when the turn finishes; never over the terminal. */}
        {session.status === 'attention' && session.reason === 'finished' && <span className="flag-sweep" aria-hidden="true" />}
        <ColorDot color={session.color} />
        <span className="session-name">{session.name}</span>
        {session.model && <span className="model">{session.model}</span>}
        <Tachometer sessionId={session.id} />
        <span className="spacer" />
        <Elapsed since={session.statusSince} />
        <StorySelect session={session} />
        <BackgroundButton session={session} />
        <SessionActions session={session} />
      </header>
      <div className="card-reason">
        <span className={`reason tone-${statusTone(session)}`}>{reasonLabel(session)}</span>
        {!waiting && <span className="hint">no longer waiting — this card leaves when you click elsewhere</span>}
        <span className="spacer" />
        {session.status === 'attention' && session.reason === 'finished' && (
          <button type="button" onClick={() => void api.ackSession(session.id).catch(() => undefined)}>
            Mark as seen
          </button>
        )}
      </div>
      <SessionBody session={session} onFocusChange={onFocusChange} />
    </section>
  );
}

function Row({ session }: { session: SessionInfo }): React.JSX.Element {
  return (
    <li>
      <button type="button" className="row" onClick={() => setView({ kind: 'single', id: session.id })}>
        <ColorDot color={session.color} />
        <span className="session-name">{session.name}</span>
        {session.model && <span className="model">{session.model}</span>}
        <StatusBadge session={session} />
        <span className="spacer" />
        <Elapsed since={session.statusSince} />
      </button>
    </li>
  );
}

/**
 * The sessions waiting for the user, each as a live terminal that can be answered in place.
 * The card being typed in keeps its position even if its session stops waiting.
 */
export function AttentionPanel({ storyFilter }: { storyFilter?: string | null }): React.JSX.Element {
  const { sessions: allSessions, stories, loaded } = useStore();
  const sessions = inStory(allSessions, storyFilter, stories);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const previous = useRef<string[]>([]);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(release.current), []);

  // Leaving a terminal lets go of its card a moment later, not at once: focus moves on
  // mouse-down, and removing a card right then would shift the page under the pointer
  // before the click on another card's button has landed.
  const onFocusChange = (id: string, focused: boolean): void => {
    clearTimeout(release.current);
    if (focused) {
      setFocusedId(id);
      return;
    }
    release.current = setTimeout(() => setFocusedId((current) => (current === id ? null : current)), RELEASE_DELAY_MS);
  };

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const stillFocused = focusedId !== null && byId.has(focusedId) ? focusedId : null;
  const cardIds = visibleCards(selectAttention(sessions), previous.current, stillFocused);
  previous.current = cardIds;
  // "All clear" is marked only when cards were there and the last one has just been handled.
  const hadCards = useRef(false);
  const allClear = cardIds.length === 0 && hadCards.current;
  if (cardIds.length > 0) hadCards.current = true;

  const shown = new Set(cardIds);
  const rest = sessions.filter((s) => !shown.has(s.id));
  const working = rest.filter((s) => s.status === 'working');
  const quiet = rest.filter((s) => s.status === 'idle' || s.status === 'running');
  const exited = rest.filter((s) => s.status === 'exited');

  return (
    <div className="attention">
      <div className="view-tools">
        <StoryFilter value={storyFilter} onChange={(v) => setView({ kind: 'attention', storyFilter: v })} />
      </div>
      {cardIds.length === 0 ? (
        <p className={allClear ? 'empty all-clear' : 'empty'}>{loaded ? (allSessions.length === 0 ? 'No sessions are open. Start one from the sidebar.' : 'Nothing needs you.') : 'Loading…'}</p>
      ) : (
        <div className="cards">
          {cardIds.map((id) => {
            const s = byId.get(id);
            if (!s) return null;
            return (
              <Card
                key={id}
                session={s}
                onFocusChange={(focused) => onFocusChange(id, focused)}
              />
            );
          })}
        </div>
      )}

      {working.length > 0 && (
        <>
          <h2>Working</h2>
          <ul className="rows">{working.map((s) => <Row key={s.id} session={s} />)}</ul>
        </>
      )}
      {quiet.length > 0 && (
        <>
          <h2>Idle</h2>
          <ul className="rows">{quiet.map((s) => <Row key={s.id} session={s} />)}</ul>
        </>
      )}
      {exited.length > 0 && (
        <>
          <h2>Exited</h2>
          <ul className="rows">{exited.map((s) => <Row key={s.id} session={s} />)}</ul>
        </>
      )}
    </div>
  );
}
