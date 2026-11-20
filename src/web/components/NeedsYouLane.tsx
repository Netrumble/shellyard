import { useState } from 'react';
import type { PermissionChoice, SessionInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { answerable, areaRuleFor, askLine, REQUEST_BADGE, requestKind, type RequestKind } from '../requests.js';
import { selectAttention } from '../selectors.js';
import { modelLabel, waitClock } from '../session-text.js';
import { setView, useStore } from '../store.js';
import { useNow } from './Cluster.js';
import { StatusGlyph } from './StatusGlyph.js';

type CardKind = RequestKind;
const kindOf = requestKind;
const BADGE = REQUEST_BADGE;

function CardHead({ session, kind, since }: { session: SessionInfo; kind: CardKind; since: number }): React.JSX.Element {
  const now = useNow(1000);
  const clock = waitClock(now - since);
  return (
    <header className="ny-head">
      <span className="ny-badge">
        <StatusGlyph session={session} size={12} />
        {BADGE[kind]}
      </span>
      <h3 className="ny-name">{session.name}</h3>
      <span className="ny-clock" aria-label={`waiting for ${clock}`}>
        {clock}
      </span>
    </header>
  );
}

function OpenTerminal({ session, label = 'Open terminal' }: { session: SessionInfo; label?: string }): React.JSX.Element {
  return (
    <button type="button" className="ny-link" onClick={() => setView({ kind: 'single', id: session.id })}>
      {label}
    </button>
  );
}

/** A session blocked on a permission: what it wants to run, and the answers that fit. */
function PermissionCard({ session }: { session: SessionInfo }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = session.pending;
  const canAnswer = answerable(session);
  const { stories } = useStore();
  const rule = areaRuleFor(session, new Set(stories.map((s) => s.id)));
  const areaName = stories.find((s) => s.id === session.storyId)?.name ?? '';

  const answer = async (choice: PermissionChoice): Promise<void> => {
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await api.answer(session.id, p.id, choice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="ny-card ny-permission" aria-label={`${session.name}: permission`}>
      <CardHead session={session} kind="permission" since={p?.since ?? session.statusSince} />
      <div className="ny-request">
        {p?.detail ? (
          <code className="ny-code">
            {p.tool && <span className="ny-tool">{p.tool}</span>} {p.detail}
          </code>
        ) : (
          <p className="ny-message">{p?.message ?? 'Claude Code is waiting for a permission or an answer.'}</p>
        )}
        {canAnswer && <p className="ny-ask">{askLine(session)}</p>}
        {rule && (
          <p className="ny-ask">
            "Always in this area" adds the rule <code>{rule}</code> to {areaName}.
          </p>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="ny-actions">
        {canAnswer && (
          <>
            <button type="button" className="ny-primary" disabled={busy} onClick={() => void answer('once')}>
              Allow once
            </button>
            {rule && (
              <button
                type="button"
                disabled={busy}
                title={`Allows it now, and adds the rule "${rule}" to ${areaName}: its sessions will run such commands without asking.`}
                onClick={() => void answer('area')}
              >
                Always in this area
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void answer('deny')}>
              Deny
            </button>
          </>
        )}
        <OpenTerminal session={session} />
      </div>
    </article>
  );
}

function QuestionCard({ session }: { session: SessionInfo }): React.JSX.Element {
  const p = session.pending;
  const text = p?.detail ?? p?.message ?? 'Claude Code is waiting for your answer.';
  return (
    <article className="ny-card ny-permission" aria-label={`${session.name}: question`}>
      <CardHead session={session} kind="question" since={p?.since ?? session.statusSince} />
      <div className="ny-request">
        <p className="ny-message">{text}</p>
      </div>
      <div className="ny-actions">
        <OpenTerminal session={session} label="Reply in the terminal" />
      </div>
    </article>
  );
}

function MaybeCard({ session }: { session: SessionInfo }): React.JSX.Element {
  return (
    <article className="ny-card ny-permission" aria-label={`${session.name}: possibly waiting`}>
      <CardHead session={session} kind="maybe" since={session.statusSince} />
      <div className="ny-request">
        <p className="ny-message">Its terminal has gone quiet without saying it finished: it may be waiting for you.</p>
      </div>
      <div className="ny-actions">
        <OpenTerminal session={session} />
      </div>
    </article>
  );
}

function FinishedCard({ session }: { session: SessionInfo }): React.JSX.Element {
  const model = modelLabel(session.model);
  return (
    <article className="ny-card ny-finished" aria-label={`${session.name}: finished`}>
      <CardHead session={session} kind="finished" since={session.statusSince} />
      <div className="ny-request">
        <p className="ny-message">Finished its turn{model ? ` · ${model}` : ''}. It stays here until you have seen it.</p>
      </div>
      <div className="ny-actions">
        <button type="button" className="ny-primary" onClick={() => setView({ kind: 'single', id: session.id })}>
          Open terminal
        </button>
        <button type="button" onClick={() => void api.ackSession(session.id).catch(() => undefined)}>
          Mark as seen
        </button>
      </div>
    </article>
  );
}

const CARDS: Record<CardKind, (p: { session: SessionInfo }) => React.JSX.Element> = {
  permission: PermissionCard,
  question: QuestionCard,
  maybe: MaybeCard,
  finished: FinishedCard,
};

/**
 * The sessions waiting for the user, on top of the board: blocked ones first, then finished
 * ones, the longest wait first in each. Absent when nothing waits.
 */
export function NeedsYouLane(): React.JSX.Element | null {
  const { sessions } = useStore();
  const waiting = selectAttention(sessions);
  if (waiting.length === 0) return null;
  return (
    <section className="needs-you" aria-labelledby="needs-you-title">
      <header className="section-head">
        <h2 id="needs-you-title" className="section-name">
          <span className="needs-you-mark" aria-hidden="true" />
          Needs you now
        </h2>
        <span className="hint">Sorted by how long they have been waiting</span>
      </header>
      <div className="ny-grid">
        {waiting.map((s) => {
          const Card = CARDS[kindOf(s)];
          return <Card key={s.id} session={s} />;
        })}
      </div>
    </section>
  );
}
