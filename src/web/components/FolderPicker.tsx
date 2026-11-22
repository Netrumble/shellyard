import { useState } from 'react';
import type { FolderListing } from '../../shared/types.js';
import { api } from '../api.js';

/**
 * A folder field: type the path, or browse the folders of this machine and pick one. The
 * browsing goes through the server, because a web page cannot ask the system's own folder
 * dialog for a full path.
 */
export function FolderPicker(props: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  labelledBy?: string;
  /** Where browsing begins while the field is empty: the folder used when none is typed. */
  start?: string;
}): React.JSX.Element {
  const { value, onChange, placeholder, labelledBy, start } = props;
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async (path?: string, fallBackHome = false): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setListing(await api.folders(path));
    } catch (e) {
      // A default folder that is gone is no fault of the user: show the home folder instead.
      if (fallBackHome && path) {
        setBusy(false);
        return go(undefined);
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    // Start where the field points; empty, at the default folder, else the home folder.
    const typed = value.trim();
    void go(typed || start?.trim() || undefined, !typed).then(() => undefined);
  };

  const choose = (path: string): void => {
    onChange(path);
    setOpen(false);
  };

  return (
    <div className="folder-picker">
      <div className="folder-row">
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} aria-labelledby={labelledBy} />
        <button type="button" onClick={toggle} aria-expanded={open}>
          {open ? 'Close' : 'Browse'}
        </button>
      </div>
      {open && (
        <div className="folder-browser">
          {error && (
            <p className="error" role="alert">
              {error}{' '}
              <button type="button" className="link" onClick={() => void go(undefined)}>
                Go to the home folder
              </button>
            </p>
          )}
          {listing && (
            <>
              <div className="folder-bar">
                <span className="folder-current">{listing.path}</span>
                <button type="button" disabled={listing.parent === null || busy} onClick={() => listing.parent && void go(listing.parent)}>
                  Up
                </button>
                {listing.roots.length > 1 && (
                  <select aria-label="Drive" value="" onChange={(e) => e.target.value && void go(e.target.value)}>
                    <option value="">Drive…</option>
                    {listing.roots.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
                <span className="spacer" />
                <button type="button" className="primary" onClick={() => choose(listing.path)}>
                  Use this folder
                </button>
              </div>
              {listing.folders.length === 0 ? (
                <p className="hint">No folders inside this one.</p>
              ) : (
                <ul className="folder-list">
                  {listing.folders.map((f) => (
                    <li key={f.path}>
                      <button type="button" disabled={busy} onClick={() => void go(f.path)}>
                        {f.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {!listing && !error && <p className="hint">Loading…</p>}
        </div>
      )}
    </div>
  );
}
