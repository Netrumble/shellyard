import { useState } from 'react';
import type { Profile, SessionKind, TerminalBackground, TerminalFont } from '../../shared/types.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { refreshMeta, useStore } from '../store.js';
import { BackgroundEditor } from './BackgroundEditor.js';
import { FolderPicker } from './FolderPicker.js';
import { FontEditor } from './FontEditor.js';
import { splitCommandLine } from '../command-line.js';

const NEW_COLOR = '#888888';

/**
 * The settings of one launcher (a profile in the code and the config): its name, where its
 * sessions start, and what their terminal looks like. Without a profile it creates a new one,
 * and then also asks for the command, the kind and the colour.
 */
export function ProfileDialog({ profile: given, onClose }: { profile?: Profile; onClose: () => void }): React.JSX.Element {
  const { meta } = useStore();
  const creating = given === undefined;
  const [blank] = useState<Profile>(() => ({ id: `profile-${Date.now().toString(36)}`, name: '', kind: 'shell', command: '', args: [], cwd: '', color: NEW_COLOR, env: {}, model: null }));
  const profile = given ?? blank;
  const [name, setName] = useState(profile.name);
  const [commandLine, setCommandLine] = useState('');
  const [kind, setKind] = useState<SessionKind>('shell');
  const [color, setColor] = useState(NEW_COLOR);
  const [cwd, setCwd] = useState(profile.cwd);
  const [background, setBackground] = useState<TerminalBackground | null>(profile.background ?? null);
  const [font, setFont] = useState<TerminalFont | null>(profile.font ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSaved = meta.saved.includes(profile.id);
  const isBuiltin = profile.id.startsWith('builtin-');

  useEscape(onClose);

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
    if (creating) {
      const [command, ...args] = splitCommandLine(commandLine);
      if (!command) {
        setError('Enter the command to run.');
        return;
      }
      void run([...others(), { ...profile, name: name.trim(), kind, command, args, color, cwd: cwd.trim(), background, font }]);
      return;
    }
    void run([...others(), { ...profile, name: name.trim(), cwd: cwd.trim(), background, font }]);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog wide" onSubmit={submit} aria-label={creating ? 'New launcher' : `Launcher ${profile.name}`}>
        <h2>{creating ? 'New launcher' : `Launcher: ${profile.name}`}</h2>
        {!creating && <p className="hint command">{[profile.command, ...profile.args].join(' ')}</p>}

        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} spellCheck={false} autoFocus />
        </label>

        {creating && (
          <>
            <label>
              <span>Command</span>
              <input value={commandLine} onChange={(e) => setCommandLine(e.target.value)} placeholder="pwsh, bash, wsl -d Ubuntu, claude, or a full path" spellCheck={false} />
            </label>
            <label>
              <span>Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
                <option value="shell">Shell or other program</option>
                <option value="claude">Claude Code</option>
              </select>
            </label>
            <label>
              <span>Colour</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </>
        )}

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
