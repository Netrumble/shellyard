import { useCallback, useEffect, useState } from 'react';
import type { ConversationItem } from '../../shared/types.js';
import { api } from '../api.js';
import { durationLabel } from '../gauges.js';
import { requestPermissionOnce } from '../notify.js';
import { setView, useStore } from '../store.js';

/**
 * Claude Code conversations saved on this machine, whichever window they were held in.
 * A running session in another window cannot be taken over, but its conversation can be
 * continued here in a new session.
 */
export function ConversationsView(): React.JSX.Element {
  const { sessions, stories } = useStore();
  const [areaId, setAreaId] = useState('');
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setItems(await api.conversations());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Which conversations are open here changes as sessions start and end.
  const liveCount = sessions.filter((s) => s.status !== 'exited').length;
  useEffect(() => {
    void load();
  }, [load, liveCount]);

  const resume = async (c: ConversationItem): Promise<void> => {
    setBusy(c.id);
    setError(null);
    try {
      requestPermissionOnce();
      const area = stories.find((s) => s.id === areaId);
      const session = await api.createSession(area ? { resume: c.id, storyId: area.id } : { resume: c.id });
      if (session.error) setError(session.error);
      else setView({ kind: 'single', id: session.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  return (
    <div className="conversations">
      <p>
        Conversations Claude Code has saved on this machine, most recent first. Resuming one starts a new session here with the whole
        conversation in it. If it is still open in another window, close it there first: two sessions writing to the same conversation
        confuse each other.
      </p>
      <div className="view-tools">
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
        {stories.length > 0 && (
          <label className="story-filter">
            <span>Resume into</span>
            <select value={stories.some((s) => s.id === areaId) ? areaId : ''} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">No area</option>
              {stories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items === null && !error && <p className="empty">Loading…</p>}
      {items !== null && items.length === 0 && <p className="empty">No saved conversations found.</p>}
      {items !== null && items.length > 0 && (
        <ul className="conversation-list">
          {items.map((c) => (
            <li key={c.id}>
              <div className="conversation-text">
                <strong>{c.title}</strong>
                <span className="command">{c.cwd}</span>
              </div>
              <span className="elapsed">{now - c.updatedAt < 60_000 ? 'just now' : `${durationLabel(now - c.updatedAt)} ago`}</span>
              {c.openIn ? (
                <button type="button" onClick={() => setView({ kind: 'single', id: c.openIn! })}>
                  Open here: show
                </button>
              ) : (
                <button type="button" className="primary" disabled={busy !== null} onClick={() => void resume(c)}>
                  Resume here
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
