import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SoundSettings } from '../../shared/types.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { playSound } from '../sounds.js';
import { refreshSounds, useStore } from '../store.js';

const EVENTS: Array<{ key: keyof SoundSettings; label: string }> = [
  { key: 'blocked', label: 'Needs permission' },
  { key: 'finished', label: 'Finished' },
  { key: 'maybeWaiting', label: 'Maybe waiting' },
];

/** Which sound plays for each event, and the sounds that can be chosen. */
export function SoundsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEscape(onClose);
  useEffect(() => {
    void refreshSounds();
  }, []);
  const { sounds, settings } = useStore().soundLibrary;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refreshSounds();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = (key: keyof SoundSettings, value: string): void => {
    // Merge into the settings as the server has them now, not as this page last saw them.
    void run(async () => api.saveSoundSettings({ ...(await api.sounds()).settings, [key]: value || null }));
  };

  const add = (file: File | undefined): void => {
    if (fileInput.current) fileInput.current.value = '';
    if (file) void run(() => api.addSound(file));
  };

  const remove = (id: string, name: string): void => {
    if (!window.confirm(`Delete the sound "${name}"? Settings and areas using it go back to the defaults.`)) return;
    void run(() => api.deleteSound(id));
  };

  return createPortal(
    <div
      className="overlay"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog sounds-dialog" role="dialog" aria-label="Sounds">
        <h2>Sounds</h2>

        {EVENTS.map(({ key, label }) => {
          const value = settings[key] && sounds.some((s) => s.id === settings[key]) ? settings[key]! : '';
          return (
            <div className="sound-row" key={key}>
              <label>
                <span>{label}</span>
                <select value={value} disabled={busy} onChange={(e) => choose(key, e.target.value)}>
                  <option value="">Chime</option>
                  {sounds.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => void playSound(value || null)}>
                Play
              </button>
            </div>
          );
        })}

        <div className="field">
          <span>Added sounds</span>
          {sounds.length === 0 ? (
            <span className="hint">None yet.</span>
          ) : (
            <ul className="sound-list">
              {sounds.map((s) => (
                <li key={s.id}>
                  <span className="sound-name">{s.name}</span>
                  <button type="button" onClick={() => void playSound(s.id)}>
                    Play
                  </button>
                  <button type="button" disabled={busy} onClick={() => remove(s.id, s.name)}>
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={fileInput}
            type="file"
            accept="audio/mpeg,audio/wav,audio/x-wav,audio/ogg,.mp3,.wav,.ogg"
            aria-label="Add sound…"
            disabled={busy}
            onChange={(e) => add(e.target.files?.[0])}
          />
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-buttons">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
