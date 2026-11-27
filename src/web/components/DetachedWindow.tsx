import { useEffect } from 'react';
import { reasonLabel } from '../attention.js';
import { announceDetached } from '../detached.js';
import { useStore } from '../store.js';
import { Elapsed } from './SessionBits.js';
import { SessionBody, TileHeader } from './TerminalsGrid.js';

/**
 * The page of a session's own window: only its terminal, full size. Closing the window brings
 * the session back into the main page; the session itself keeps running.
 */
export function DetachedWindow({ id }: { id: string }): React.JSX.Element {
  const { sessions, loaded, connection } = useStore();
  const session = sessions.find((s) => s.id === id);

  useEffect(() => announceDetached(id), [id]);

  // The window's title is the session's, so it can be told apart in the taskbar.
  useEffect(() => {
    const mark = session?.status === 'attention' ? '● ' : '';
    document.title = session ? `${mark}${session.name} · ShellYard` : 'ShellYard';
  }, [session?.name, session?.status]);

  // A session that ends while shown here (closed, or its area removed with it) takes the window away.
  const gone = loaded && connection === 'open' && !session;
  useEffect(() => {
    if (gone) window.close();
  }, [gone]);

  if (connection === 'unauthorized' || connection === 'down') {
    return (
      <main className="down">
        <h1>{connection === 'down' ? 'ShellYard is not running' : 'Open ShellYard from a terminal'}</h1>
        <p>
          Run <code>shellyard</code> in a terminal. {connection === 'down' ? 'This window reconnects by itself.' : ''}
        </p>
      </main>
    );
  }

  return (
    <div className="detached-app">
      {connection !== 'open' && (
        <div className="banner" role="status">
          {connection === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
        </div>
      )}
      {session ? (
        <section className="tile single detached">
          <TileHeader session={session} inOwnWindow>
            <span className="hint">
              {reasonLabel(session)} <Elapsed since={session.statusSince} />
            </span>
            <button type="button" title="Close this window and show the session in the main page again" onClick={() => window.close()}>
              Bring back
            </button>
          </TileHeader>
          <SessionBody session={session} autoFocus inOwnWindow />
        </section>
      ) : (
        <p className="empty">{loaded ? 'This session no longer exists.' : 'Loading…'}</p>
      )}
    </div>
  );
}
