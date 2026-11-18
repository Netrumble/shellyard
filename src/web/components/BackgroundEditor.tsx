import { useEffect, useState } from 'react';
import type { SessionInfo, TerminalBackground, TerminalFont } from '../../shared/types.js';
import { api, backgroundUrl, uploadBackground } from '../api.js';
import { hostStyle, terminalIsLight, terminalLook, THEME_TERMINAL } from '../terminal-look.js';
import { useStore } from '../store.js';
import { FontEditor } from './FontEditor.js';

type Kind = 'theme' | 'color' | 'image';
const DEFAULT_VEIL = 0.55;

/**
 * Chooses what is behind the text of a terminal: the theme's own background, a colour, or
 * an uploaded image under a grey-black veil whose strength can be set.
 */
export function BackgroundEditor({ value, onChange }: { value: TerminalBackground | null; onChange: (v: TerminalBackground | null) => void }): React.JSX.Element {
  const { theme } = useStore();
  const kind: Kind = value?.image ? 'image' : value?.color ? 'color' : 'theme';
  const [picked, setPicked] = useState<Kind>(kind);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setPicked(kind), [kind]);
  useEffect(() => {
    let current = true;
    setImageUrl(null);
    if (value?.image) backgroundUrl(value.image).then((u) => current && setImageUrl(u), () => undefined);
    return () => {
      current = false;
    };
  }, [value?.image]);

  const choose = (k: Kind): void => {
    setPicked(k);
    setError(null);
    if (k === 'theme') onChange(null);
    if (k === 'color') onChange({ color: value?.color ?? (terminalIsLight(theme) ? '#101418' : '#f4f1e8'), image: null, veil: DEFAULT_VEIL });
    // An image is only set once a file has been chosen; until then the choice stays as it was.
  };

  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange({ color: null, image: await uploadBackground(file), veil: value?.veil ?? DEFAULT_VEIL });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const look = terminalLook(value, theme, THEME_TERMINAL[theme]);
  const preview = value?.image ? hostStyle(value, imageUrl) : { background: look.background };

  return (
    <div className="background-editor">
      <div className="background-choice" role="radiogroup" aria-label="Terminal background">
        {(['theme', 'color', 'image'] as const).map((k) => (
          <label key={k}>
            <input type="radio" name="background-kind" checked={picked === k} onChange={() => choose(k)} />
            <span>{k === 'theme' ? 'As the theme' : k === 'color' ? 'A colour' : 'An image'}</span>
          </label>
        ))}
      </div>
      {picked !== 'theme' && (
        <div className="background-detail">
          <div className="background-preview" style={{ ...preview, color: look.foreground }} aria-hidden="true">
            PS C:\&gt; _
          </div>
          {picked === 'color' && (
            <label>
              <span>Colour</span>
              <input type="color" value={value?.color ?? '#101418'} onChange={(e) => onChange({ color: e.target.value, image: null, veil: value?.veil ?? DEFAULT_VEIL })} />
            </label>
          )}
          {picked === 'image' && (
            <>
              <label>
                <span>{value?.image ? 'Replace' : 'Choose'}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
              </label>
              {value?.image && (
                <label>
                  <span>Veil</span>
                  <input
                    type="range"
                    min="0"
                    max="0.95"
                    step="0.05"
                    value={value.veil}
                    aria-valuetext={`${Math.round(value.veil * 100)}% dark`}
                    onChange={(e) => onChange({ color: null, image: value.image, veil: Number(e.target.value) })}
                  />
                  <span className="hint">{Math.round(value.veil * 100)}% dark</span>
                </label>
              )}
            </>
          )}
        </div>
      )}
      {picked === 'image' && !value?.image && !error && <p className="hint">PNG, JPEG, WebP or GIF, up to 8 MB. It is copied into ShellYard&apos;s own folder.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The dialog that changes the look of one terminal that is already open: background and text. */
function SessionBackgroundDialog({ session, onClose }: { session: SessionInfo; onClose: () => void }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Each change is applied at once, so the terminal behind the dialog shows the result.
  const change = (background: TerminalBackground | null): void => {
    setError(null);
    api.updateSession(session.id, { background }).catch((e: unknown) => setError((e as Error).message));
  };

  const changeFont = (font: TerminalFont | null): void => {
    setError(null);
    api.updateSession(session.id, { font }).catch((e: unknown) => setError((e as Error).message));
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label={`Look of ${session.name}`}>
        <h2>Look of {session.name}</h2>
        <div className="field">
          <span>Background</span>
          <BackgroundEditor value={session.background} onChange={change} />
        </div>
        <div className="field">
          <span>Text</span>
          <FontEditor value={session.font} onChange={changeFont} />
        </div>
        <p className="hint">This changes this terminal only. A launcher&apos;s own look is set with the pencil beside the launcher.</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function BackgroundButton({ session }: { session: SessionInfo }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (session.error) return null;
  return (
    <>
      <button type="button" className="icon" title="Terminal look: background, font and text size" aria-label={`Look of ${session.name}`} onClick={() => setOpen(true)}>
        ◐
      </button>
      {open && <SessionBackgroundDialog session={session} onClose={() => setOpen(false)} />}
    </>
  );
}
