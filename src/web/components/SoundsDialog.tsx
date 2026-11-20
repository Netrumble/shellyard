import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TRIM_RULE, typedTrim, type Trim } from '../../shared/trim.js';
import type { SoundFile, SoundSettings } from '../../shared/types.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { playSound } from '../sounds.js';
import { refreshSounds, saveSoundTrim, useStore } from '../store.js';

const EVENTS: Array<{ key: keyof SoundSettings; label: string }> = [
  { key: 'blocked', label: 'Needs permission' },
  { key: 'finished', label: 'Finished' },
  { key: 'maybeWaiting', label: 'Maybe waiting' },
];

const shown = (n: number | null): string => (n === null ? '' : String(n));

/**
 * Start and End of a sound, saved when the focus leaves both fields with a changed value, or on Enter;
 * whatever takes the focus, the Close button included. Escape and a click on the backdrop close the
 * dialog without saving what is being typed (`closing` says so, whatever events removal fires).
 * The valid cut being typed goes to `onDraft` (null: none), so Play can use it before it is saved.
 */
function TrimFields(props: {
  sound: SoundFile;
  onDraft: (draft: Trim | null) => void;
  onSave: (trim: Trim) => Promise<boolean>;
  onInvalid: (message: string) => void;
  closing: () => boolean;
}): React.JSX.Element {
  const { sound } = props;
  const latest = useRef(sound);
  latest.current = sound;
  const [start, setStart] = useState(shown(sound.start));
  const [end, setEnd] = useState(shown(sound.end));
  // True from the first key until the typed cut is answered: a library read meanwhile does not overwrite it.
  const editing = useRef(false);
  // Keys typed, and how many of them the last leaving of the fields took in: a save that answers
  // while newer text waits to be left does not overwrite it.
  const edits = useRef(0);
  const committed = useRef(0);
  // The last cut sent and not answered yet: the server is about to hold it, not `sound`.
  const sent = useRef<Trim | null>(null);
  // What the server keeps wins over the fields, unless the user is changing them.
  useEffect(() => {
    if (!editing.current) setStart(shown(sound.start));
  }, [sound.start]);
  useEffect(() => {
    if (!editing.current) setEnd(shown(sound.end));
  }, [sound.end]);

  const show = (trim: Trim): void => {
    setStart(shown(trim.start));
    setEnd(shown(trim.end));
  };

  const edit = (nextStart: string, nextEnd: string): void => {
    setStart(nextStart);
    setEnd(nextEnd);
    editing.current = true;
    edits.current++;
    props.onDraft(typedTrim(nextStart, nextEnd));
  };

  const commit = async (e: React.FocusEvent<HTMLSpanElement>): Promise<void> => {
    // Moving between Start and End is not leaving the cut; nor is the dialog going away.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    if (props.closing()) return;
    const trim = typedTrim(start, end);
    if (!trim) {
      props.onInvalid(`"${sound.name}": ${TRIM_RULE}`);
      return;
    }
    committed.current = edits.current;
    const held = sent.current ?? sound;
    if (trim.start === held.start && trim.end === held.end) {
      // Nothing to send; a save still on its way settles the fields when it answers.
      show(trim);
      if (!sent.current) {
        editing.current = false;
        props.onDraft(null);
      }
      return;
    }
    sent.current = trim;
    const saved = await props.onSave(trim);
    if (sent.current !== trim) return; // a later cut was sent: its answer decides
    sent.current = null;
    if (edits.current !== committed.current) return; // newer text, not left yet: it stays
    editing.current = false;
    props.onDraft(null);
    // As stored (rounded); or, when the save failed (its error is shown), what the server still has.
    show(saved ? trim : latest.current);
  };

  // Enter saves: leaving the field is what saves, and nothing else takes the focus.
  const enter = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') e.currentTarget.blur();
  };

  return (
    <span className="sound-trim" onBlur={(e) => void commit(e)}>
      <label>
        <span>Start</span>
        <input type="text" inputMode="decimal" value={start} placeholder="0" onKeyDown={enter} onChange={(e) => edit(e.target.value, end)} aria-label={`Start of ${sound.name}, in seconds`} />
      </label>
      <label>
        <span>End</span>
        <input type="text" inputMode="decimal" value={end} placeholder="end" onKeyDown={enter} onChange={(e) => edit(start, e.target.value)} aria-label={`End of ${sound.name}, in seconds (empty: the end of the file)`} />
      </label>
      <span className="hint">s</span>
    </span>
  );
}

/** Which sound plays for each event, and the sounds that can be chosen. */
export function SoundsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  // Set by the ways of closing that do not save what is being typed.
  const closing = useRef(false);
  const discardAndClose = (): void => {
    closing.current = true;
    onClose();
  };
  useEscape(discardAndClose);
  useEffect(() => {
    void refreshSounds();
  }, []);
  const { sounds, settings } = useStore().soundLibrary;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Cuts typed but not saved yet, by sound id: Play uses them over the stored ones.
  const [drafts, setDrafts] = useState<Record<string, Trim>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const cuts = sounds.map((s) => (drafts[s.id] ? { ...s, ...drafts[s.id] } : s));

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

  const draft = (id: string, trim: Trim | null): void =>
    setDrafts((d) => {
      const { [id]: _, ...rest } = d;
      return trim ? { ...rest, [id]: trim } : rest;
    });

  // Not through run(): a cut being saved disables nothing, so the focus stays where the user put it.
  const saveTrim = async (id: string, trim: Trim): Promise<boolean> => {
    setError(null);
    try {
      // The store puts the answer, the sound as stored, into the library.
      await saveSoundTrim(id, trim);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
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
        if (e.target === e.currentTarget) discardAndClose();
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
              <button type="button" onClick={() => void playSound(value || null, cuts)}>
                Play
              </button>
            </div>
          );
        })}

        <div className="field">
          <span>Added sounds</span>
          <div className="sound-library">
            {sounds.length === 0 ? (
              <span className="hint">None yet.</span>
            ) : (
              <ul className="sound-list">
                {sounds.map((s) => (
                  <li key={s.id}>
                    <span className="sound-name" title={s.name}>
                      {s.name}
                    </span>
                    <span className="sound-controls">
                      <TrimFields sound={s} onDraft={(trim) => draft(s.id, trim)} onSave={(trim) => saveTrim(s.id, trim)} onInvalid={setError} closing={() => closing.current} />
                      <button type="button" onClick={() => void playSound(s.id, cuts)}>
                        Play
                      </button>
                      <button type="button" disabled={busy} onClick={() => remove(s.id, s.name)}>
                        Delete
                      </button>
                    </span>
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
