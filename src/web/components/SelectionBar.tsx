import { useState } from 'react';
import { MAX_PROMPT, promptRefusal } from '../../shared/sessions.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { sendReport } from '../selection.js';
import { clearSelection, toggleSelection, useStore } from '../store.js';

const NO_AREA = '__none__';

/**
 * The sessions picked on the board (Shift-click), and what can be done to all of them at once:
 * one prompt typed into each that waits at its prompt, mark the finished ones as seen, move
 * them all to an area. Escape lets go of the selection.
 */
export function SelectionBar(): React.JSX.Element | null {
  const { selection } = useStore();
  // Mounted only with something picked, so that Escape is taken only then.
  return selection.length > 0 ? <Bar /> : null;
}

function Bar(): React.JSX.Element | null {
  const { sessions, stories, selection } = useStore();
  const [prompt, setPrompt] = useState('');
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ text: string; error: boolean } | null>(null);
  useEscape(clearSelection);

  const picked = selection.map((id) => sessions.find((s) => s.id === id)).filter((s) => s !== undefined);
  const ready = picked.filter((s) => promptRefusal(s) === null);
  const finished = picked.filter((s) => s.status === 'attention' && s.reason === 'finished');
  const names = new Map(picked.map((s) => [s.id, s.name]));

  const run = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setReport(null);
    try {
      setReport({ text: await work(), error: false });
    } catch (e) {
      setReport({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const send = (): Promise<void> =>
    run(async () => {
      const { results } = await api.sendPrompt(picked.map((s) => s.id), prompt);
      if (results.some((r) => r.outcome === 'sent')) setPrompt('');
      return sendReport(results, names);
    });

  const markSeen = (): Promise<void> =>
    run(async () => {
      const done = await Promise.allSettled(finished.map((s) => api.ackSession(s.id)));
      const ok = done.filter((d) => d.status === 'fulfilled').length;
      return `Marked ${ok} of ${finished.length} as seen.`;
    });

  const move = (): Promise<void> =>
    run(async () => {
      const target = area === NO_AREA ? null : area;
      const done = await Promise.allSettled(picked.map((s) => api.moveSession(s.id, target)));
      const ok = done.filter((d) => d.status === 'fulfilled').length;
      const where = target ? (stories.find((s) => s.id === target)?.name ?? 'the area') : 'no area';
      return `Moved ${ok} of ${picked.length} to ${where}.`;
    });

  if (picked.length === 0) return null;
  const tooLong = prompt.length > MAX_PROMPT;

  return (
    <section className="selection-bar" aria-labelledby="selection-title">
      <header className="selection-head">
        <h2 id="selection-title" className="section-name">
          {picked.length} picked
        </h2>
        <ul className="selection-chips" aria-label="Picked sessions">
          {picked.map((s) => (
            <li key={s.id}>
              <button type="button" className="selection-chip" aria-label={`Unpick ${s.name}`} title="Unpick" onClick={() => toggleSelection(s.id)}>
                {s.name} <span aria-hidden="true">✕</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ny-link" onClick={clearSelection}>
          Unpick all (Esc)
        </button>
      </header>

      <div className="selection-actions">
        <form
          className="selection-prompt"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="selection-prompt-text">
            Prompt for {picked.length} session{picked.length === 1 ? '' : 's'}
          </label>
          <textarea
            id="selection-prompt-text"
            value={prompt}
            rows={3}
            placeholder="Rebase on release/2026.12, run the tests and tell me only what fails."
            aria-describedby="selection-prompt-hint"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!busy && prompt.trim() && ready.length > 0 && !tooLong) void send();
              }
            }}
          />
          <p id="selection-prompt-hint" className="hint">
            {ready.length === picked.length
              ? 'All of them wait at their prompt. Ctrl+Enter sends.'
              : `${ready.length} of ${picked.length} wait at their prompt and will take it; the others are skipped. Ctrl+Enter sends.`}
            {tooLong && ` At most ${MAX_PROMPT} characters.`}
          </p>
          <button type="submit" className="ny-primary" disabled={busy || !prompt.trim() || ready.length === 0 || tooLong}>
            Send to {ready.length}
          </button>
        </form>

        <div className="selection-side">
          <button type="button" disabled={busy || finished.length === 0} onClick={() => void markSeen()}>
            Mark all seen{finished.length > 0 ? ` (${finished.length})` : ''}
          </button>
          <div className="selection-move">
            <label>
              <span>Move to</span>
              <select value={area} onChange={(e) => setArea(e.target.value)}>
                <option value="">Choose an area…</option>
                {stories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value={NO_AREA}>No area</option>
              </select>
            </label>
            <button type="button" disabled={busy || !area} onClick={() => void move()}>
              Move
            </button>
          </div>
        </div>
      </div>

      <p className={report?.error ? 'error' : 'hint'} role="status">
        {report?.text ?? ''}
      </p>
    </section>
  );
}
