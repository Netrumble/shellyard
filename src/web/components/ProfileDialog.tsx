import { useEffect, useState } from 'react';
import type { Profile, TerminalBackground, TerminalFont } from '../../shared/types.js';
import { api } from '../api.js';
import { refreshMeta, useStore } from '../store.js';
import { BackgroundEditor } from './BackgroundEditor.js';
import { FolderPicker } from './FolderPicker.js';
import { FontEditor } from './FontEditor.js';

/** The settings of one launcher (a profile in the code and the config): where its sessions start, and what their terminal looks like. */
export function ProfileDialog({ profile, onClose }: { profile: Profile; onClose: () => void }): React.JSX.Element {
  const { meta } = useStore();
  const [name, setName] = useState(profile.name);
  const [cwd, setCwd] = useState(profile.cwd);
  const [background, setBackground] = useState<TerminalBackground | null>(profile.background ?? null);
  const [font, setFont] = useState<TerminalFont | null>(profile.font ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSaved = meta.saved.includes(profile.id);
  const isBuiltin = profile.id.startsWith('builtin-');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const others = (): Profile[] => meta.profiles.filter((p) => meta.saved.includes(p.id) && p.id !== profile.id);

  const run = async (next: Profile[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.saveProfiles(next);
      await refreshMeta();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give the launcher a name.');
      return;
    }
    void run([...others(), { ...profile, name: name.trim(), cwd: cwd.trim(), background, font }]);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog wide" onSubmit={submit} aria-label={`Launcher ${profile.name}`}>
        <h2>Launcher: {profile.name}</h2>
        <p className="hint command">{[profile.command, ...profile.args].join(' ')}</p>

        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} spellCheck={false} autoFocus />
        </label>

        <div className="field">
          <span id="profile-folder-label">Start folder</span>
          <FolderPicker value={cwd} onChange={setCwd} placeholder="Your home folder" labelledBy="profile-folder-label" />
        </div>

        <div className="field">
          <span>Terminal background</span>
          <BackgroundEditor value={background} onChange={setBackground} />
        </div>

        <div className="field">
          <span>Terminal text</span>
          <FontEditor value={font} onChange={setFont} />
        </div>

        <p className="hint">
          Sessions started from this launcher open in this folder, with this background and this text. An area&apos;s folder, or one chosen when starting
          the session, comes first.
        </p>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-buttons">
          {isSaved && isBuiltin && (
            <button type="button" disabled={busy} onClick={() => void run(others())}>
              Reset to default
            </button>
          )}
          {isSaved && !isBuiltin && (
            <button type="button" disabled={busy} onClick={() => window.confirm(`Delete the launcher "${profile.name}"?`) && void run(others())}>
              Delete launcher
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
