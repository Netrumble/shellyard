import { useEffect, useState } from 'react';
import type { Story } from '../../shared/types.js';
import { api } from '../api.js';
import { FolderPicker } from './FolderPicker.js';

/** Creates a story, or edits the one given. */
export function StoryDialog({ story, onClose }: { story?: Story; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(story?.name ?? '');
  const [ticket, setTicket] = useState(story?.ticket ?? '');
  const [cwd, setCwd] = useState(story?.cwd ?? '');
  const [color, setColor] = useState(story?.color ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give the area a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fields = { name: name.trim(), ticket: ticket.trim(), cwd: cwd.trim(), color };
      if (story) await api.updateStory(story.id, fields);
      else await api.createStory(fields);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={(e) => void submit(e)} aria-label={story ? 'Edit area' : 'New area'}>
        <h2>{story ? 'Edit area' : 'New area'}</h2>

        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="The piece of work, e.g. the ticket" autoFocus />
        </label>

        <label>
          <span>Ticket</span>
          <input value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="Optional, e.g. HCM-1234" spellCheck={false} />
        </label>

        <div className="field">
          <span id="story-folder-label">Folder</span>
          <FolderPicker value={cwd} onChange={setCwd} placeholder="Optional: where its sessions start" labelledBy="story-folder-label" />
        </div>

        <label>
          <span>Colour</span>
          <span className="color-row">
            <input type="color" value={color || '#888888'} onChange={(e) => setColor(e.target.value)} />
            {color ? (
              !story && (
                <button type="button" className="link" onClick={() => setColor('')}>
                  pick one at random
                </button>
              )
            ) : (
              <span className="hint">picked at random unless you choose one</span>
            )}
          </span>
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {story ? 'Save' : 'Create area'}
          </button>
        </div>
      </form>
    </div>
  );
}
