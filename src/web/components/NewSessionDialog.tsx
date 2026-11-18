import { useEffect, useMemo, useState } from 'react';
import type { CreateSessionRequest, Profile, SessionKind } from '../../shared/types.js';
import { api } from '../api.js';
import { requestPermissionOnce } from '../notify.js';
import { FolderPicker } from './FolderPicker.js';
import { refreshMeta, setView, useStore } from '../store.js';

const CUSTOM = '__custom__';
const DEFAULT_MODEL = '__default__';
const OTHER_MODEL = '__other__';

export function NewSessionDialog({ onClose, initialStoryId }: { onClose: () => void; initialStoryId?: string }): React.JSX.Element {
  const { meta, stories } = useStore();
  const [storyId, setStoryId] = useState(initialStoryId ?? '');
  const story = stories.find((s) => s.id === storyId);
  const [profileId, setProfileId] = useState<string>(meta.profiles[0]?.id ?? CUSTOM);
  const [kind, setKind] = useState<SessionKind>('shell');
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [color, setColor] = useState('');
  const [modelChoice, setModelChoice] = useState(DEFAULT_MODEL);
  const [otherModel, setOtherModel] = useState('');
  const [saveAsProfile, setSaveAsProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshMeta();
  }, []);

  // Profiles load after the dialog opens on a fresh page: pick the first one when they arrive.
  useEffect(() => {
    if (profileId === CUSTOM && command === '' && meta.profiles[0]) setProfileId(meta.profiles[0].id);
    // Only the arrival of the list should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.profiles.length]);

  const profile: Profile | undefined = useMemo(() => meta.profiles.find((p) => p.id === profileId), [meta.profiles, profileId]);
  const effectiveKind: SessionKind = profile ? profile.kind : kind;
  const isClaude = effectiveKind === 'claude';

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const model = (): string | null | undefined => {
    if (!isClaude) return undefined;
    if (modelChoice === DEFAULT_MODEL) return profile ? undefined : null;
    if (modelChoice === OTHER_MODEL) return otherModel.trim() || null;
    return modelChoice;
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!profile && !command.trim()) {
      setError('Enter the command to run.');
      return;
    }
    const req: CreateSessionRequest = profile ? { profileId: profile.id } : { kind, command: command.trim() };
    if (name.trim()) req.name = name.trim();
    if (cwd.trim()) req.cwd = cwd.trim();
    if (color) req.color = color;
    if (story) req.storyId = story.id;
    const m = model();
    if (m !== undefined) req.model = m;

    setBusy(true);
    try {
      if (isClaude) requestPermissionOnce();
      const session = await api.createSession(req);
      if (saveAsProfile && !session.error) {
        const saved = meta.profiles.filter((p) => meta.saved.includes(p.id));
        const created: Profile = {
          id: `profile-${Date.now().toString(36)}`,
          name: session.name,
          kind: session.kind,
          command: profile ? profile.command : command.trim(),
          args: profile ? profile.args : [],
          cwd: session.cwd,
          color: session.color,
          env: profile ? profile.env : {},
          model: session.model,
        };
        await api.saveProfiles([...saved, created]);
        await refreshMeta();
      }
      setView({ kind: 'single', id: session.id });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={(e) => void submit(e)} aria-label="New session">
        <h2>New session</h2>

        <label>
          <span>Launcher</span>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} autoFocus>
            {meta.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={CUSTOM}>Custom command…</option>
          </select>
        </label>

        {!profile && (
          <>
            <label>
              <span>Command</span>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="pwsh, bash, claude, or a full path" spellCheck={false} />
            </label>
            <label>
              <span>Type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as SessionKind)}>
                <option value="shell">Shell or other program</option>
                <option value="claude">Claude Code</option>
              </select>
            </label>
          </>
        )}

        {stories.length > 0 && (
          <label>
            <span>Area</span>
            <select value={story ? story.id : ''} onChange={(e) => setStoryId(e.target.value)}>
              <option value="">No area</option>
              {stories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={profile?.name ?? 'Optional'} />
        </label>

        <div className="field">
          <span id="session-folder-label">Folder</span>
          <FolderPicker value={cwd} onChange={setCwd} placeholder={story?.cwd || profile?.cwd || 'Your home folder'} labelledBy="session-folder-label" />
        </div>

        {isClaude && (
          <label>
            <span>Model</span>
            <select value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
              <option value={DEFAULT_MODEL}>{profile?.model ? `Launcher default (${profile.model})` : 'Default'}</option>
              {meta.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={OTHER_MODEL}>Other…</option>
            </select>
          </label>
        )}
        {isClaude && modelChoice === OTHER_MODEL && (
          <label>
            <span>Model name</span>
            <input value={otherModel} onChange={(e) => setOtherModel(e.target.value)} placeholder="A model alias or full model id" spellCheck={false} />
          </label>
        )}

        <label>
          <span>Colour</span>
          <span className="color-row">
            <input type="color" value={color || story?.color || profile?.color || '#888888'} onChange={(e) => setColor(e.target.value)} />
            {color && (
              <button type="button" className="link" onClick={() => setColor('')}>
                use the default
              </button>
            )}
          </span>
        </label>

        <label className="check">
          <input type="checkbox" checked={saveAsProfile} onChange={(e) => setSaveAsProfile(e.target.checked)} />
          <span>Save as a launcher</span>
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
            Start session
          </button>
        </div>
      </form>
    </div>
  );
}
