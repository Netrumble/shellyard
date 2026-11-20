import { useState } from 'react';
import type { AreaRule, Story } from '../../shared/types.js';
import { patternError } from '../../shared/rules.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { useStore } from '../store.js';

/** A rule switched on or off: a switch, read as such by screen readers, 44 pixels high. */
function RuleSwitch({ rule, onError }: { rule: AreaRule; onError: (m: string) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const flip = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.updateRule(rule.id, { enabled: !rule.enabled });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={rule.enabled}
      aria-label={`Allow ${rule.pattern} without asking`}
      className={rule.enabled ? 'switch on' : 'switch'}
      disabled={busy}
      onClick={() => void flip()}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}

/**
 * The commands the sessions of an area run without asking. A rule covers a Bash command word
 * by word, "*" last for any further arguments; anything that chains, pipes, redirects or
 * substitutes is always asked, whatever the rules say.
 */
export function RulesDialog({ story, onClose }: { story: Story; onClose: () => void }): React.JSX.Element {
  const rules = useStore().rules.filter((r) => r.storyId === story.id);
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const avoided = rules.reduce((n, r) => n + r.weekHits, 0);
  useEscape(onClose);

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const problem = patternError(pattern);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await api.createRule(story.id, pattern);
      setPattern('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = (r: AreaRule): void => {
    if (!window.confirm(`Delete the rule "${r.pattern}"? Its sessions will ask again before running it.`)) return;
    api.deleteRule(r.id).catch((err: unknown) => setError((err as Error).message));
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog rules-dialog" onSubmit={(e) => void add(e)} aria-labelledby="rules-title">
        <h2 id="rules-title">Area rules · {story.name}</h2>
        <p className="hint">
          Bash commands the sessions of this area run without asking. A command that chains, pipes, redirects or substitutes (; &amp; | &gt; &lt; $ ` and
          brackets) always asks.
        </p>

        {rules.length === 0 ? (
          <p className="hint">No rules yet. Add one here, or answer a request with "Always in this area".</p>
        ) : (
          <ul className="rule-list">
            {rules.map((r) => (
              <li key={r.id} className="rule-row">
                <span className="rule-text">
                  <code className="rule-pattern">{r.pattern}</code>
                  <span className="hint">{r.enabled ? `Allowed ${r.weekHits} time${r.weekHits === 1 ? '' : 's'} this week` : 'Off: always asks'}</span>
                </span>
                <RuleSwitch rule={r} onError={setError} />
                <button type="button" className="icon-button" aria-label={`Delete the rule ${r.pattern}`} title="Delete this rule" onClick={() => remove(r)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {avoided > 0 && (
          <p className="rules-avoided">
            <strong>{avoided}</strong> interruption{avoided === 1 ? '' : 's'} avoided this week
          </p>
        )}

        <label>
          <span>New rule</span>
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="dotnet test *" spellCheck={false} autoFocus />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="primary" disabled={busy || !pattern.trim()}>
            Add rule
          </button>
        </div>
      </form>
    </div>
  );
}
