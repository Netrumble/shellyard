import { useEffect, useRef, useState } from 'react';
import type { PermissionChoice, SessionInfo } from '../../shared/types.js';
import { api } from '../api.js';
import { nextSelection, queueAction, step, type QueueAction } from '../answer-queue.js';
import { visibleCards } from '../attention.js';
import { answerable, areaRuleFor, askLine, REQUEST_BADGE, requestKind, requestSummary } from '../requests.js';
import { inStory, selectAttention } from '../selectors.js';
import { shortAge, waitClock } from '../session-text.js';
import { isTypingTarget } from '../shortcuts.js';
import { setView, useStore } from '../store.js';
import { useNow } from './Cluster.js';
import { StoryFilter } from './SessionBits.js';
import { StatusGlyph } from './StatusGlyph.js';
import { SessionBody } from './TerminalsGrid.js';

/** Leaving a terminal lets go of its session a moment later: focus moves on mouse-down, before the click lands. */
const RELEASE_DELAY_MS = 400;

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className="key">{children}</kbd>;
}

function QueueItem({ session, selected, waiting, onSelect }: { session: SessionInfo; selected: boolean; waiting: boolean; onSelect: () => void }): React.JSX.Element {
  const now = useNow(1000);
  return (
    <li>
      <button type="button" className={selected ? 'queue-item selected' : 'queue-item'} aria-current={selected ? 'true' : undefined} data-session={session.id} onClick={onSelect}>
        <StatusGlyph session={session} size={16} />
        <span className="queue-item-text">
          <span className="queue-item-name">{session.name}</span>
          <span className="queue-item-line">{waiting ? requestSummary(session) : 'No longer waiting'}</span>
        </span>
        <span className="queue-item-age">{shortAge(now - (session.pending?.since ?? session.statusSince))}</span>
      </button>
    </li>
  );
}

/**
 * Every waiting session in one place, answered from the keyboard: A allows once, D denies, R
 * puts the cursor in its terminal to reply, J and K move, Enter opens the terminal. After an
 * answer the queue moves on to the next one. A session whose terminal is being typed in stays
 * put, even once it no longer waits, until the focus leaves it.
 */
export function AnswerQueue({ storyFilter }: { storyFilter?: string | null }): React.JSX.Element {
  const { sessions: all, stories, loaded } = useStore();
  const sessions = inStory(all, storyFilter, stories);
  const waiting = selectAttention(sessions);
  const waitingIds = new Set(waiting.map((s) => s.id));
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const [held, setHeld] = useState<string | null>(null);
  // The order and the selection as last shown; the next ones are worked out from them.
  const [track, setTrack] = useState<{ ids: string[]; selected: string | null }>({ ids: [], selected: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advancedAt = useRef(0);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const terminalBox = useRef<HTMLDivElement>(null);
  const listBox = useRef<HTMLUListElement>(null);
  const hadItems = useRef(false);

  const heldId = held !== null && byId.has(held) ? held : null;
  const ids = visibleCards(waiting, track.ids, heldId).filter((id) => byId.has(id));
  const selectedId = nextSelection(track.ids, ids, track.selected);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const position = selectedId ? ids.indexOf(selectedId) + 1 : 0;
  if (ids.length > 0) hadItems.current = true;

  // A selection that moved by itself (its session was answered or went away) is an advance.
  useEffect(() => {
    const moved = selectedId !== track.selected;
    if (!moved && sameList(ids, track.ids)) return;
    if (moved && track.selected !== null) {
      advancedAt.current = Date.now();
      setError(null);
      // The focus was on what has just gone, or on an answer button that now answers another
      // request: give it to the session now selected, so that Enter or Space cannot answer
      // something not yet read.
      const active = document.activeElement;
      if (active === null || active === document.body || active.closest('.queue-actions')) {
        listBox.current?.querySelector<HTMLElement>(`[data-session="${CSS.escape(selectedId ?? '')}"]`)?.focus();
      }
    }
    setTrack({ ids, selected: selectedId });
  });

  useEffect(() => () => clearTimeout(release.current), []);

  const onFocusChange = (id: string, focused: boolean): void => {
    clearTimeout(release.current);
    if (focused) setHeld(id);
    else release.current = setTimeout(() => setHeld((current) => (current === id ? null : current)), RELEASE_DELAY_MS);
  };

  const select = (id: string | null): void => {
    setError(null);
    setTrack((t) => ({ ...t, selected: id }));
  };

  const answer = async (s: SessionInfo, choice: PermissionChoice): Promise<void> => {
    const p = s.pending;
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await api.answer(s.id, p.id, choice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reply = (): void => {
    terminalBox.current?.querySelector<HTMLElement>('textarea')?.focus();
  };

  const run = (action: QueueAction): void => {
    if (action === 'next' || action === 'prev') return select(step(ids, selectedId, action === 'next' ? 1 : -1));
    if (!selected) return;
    if (action === 'allow') void answer(selected, 'once');
    else if (action === 'always') void answer(selected, 'area');
    else if (action === 'deny') void answer(selected, 'deny');
    else if (action === 'reply') reply();
    else if (action === 'open') setView({ kind: 'single', id: selected.id });
  };

  const areaIds = new Set(stories.map((x) => x.id));
  const latest = useRef({ run, selected, busy, areaIds });
  latest.current = { run, selected, busy, areaIds };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const { run: act, selected: s, busy: working, areaIds: areas } = latest.current;
      const active = document.activeElement;
      const action = queueAction(e, {
        typing: isTypingTarget(active),
        onButton: active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement,
        hasItem: s !== null,
        answerable: s !== null && answerable(s) && !working,
        canAlways: s !== null && areaRuleFor(s, areas) !== null,
        sinceAdvanceMs: Date.now() - advancedAt.current,
      });
      if (!action) return;
      e.preventDefault();
      act(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tools = (
    <div className="view-tools">
      <StoryFilter value={storyFilter} onChange={(v) => setView({ kind: 'attention', storyFilter: v })} />
    </div>
  );

  if (ids.length === 0) {
    return (
      <div className="queue">
        {tools}
        <p className={hadItems.current ? 'empty all-clear' : 'empty'}>{loaded ? (all.length === 0 ? 'No sessions are open. Start one from the sidebar.' : 'Nothing needs you.') : 'Loading…'}</p>
      </div>
    );
  }

  const stillWaiting = selected !== null && waitingIds.has(selected.id);
  const kind = selected && stillWaiting ? requestKind(selected) : null;
  const canAnswer = selected !== null && answerable(selected);
  const rule = selected ? areaRuleFor(selected, areaIds) : null;
  const areaName = stories.find((x) => x.id === selected?.storyId)?.name ?? '';
  const p = selected?.pending ?? null;

  return (
    <div className="queue">
      {tools}
      <div className="queue-layout">
        <section className="queue-side" aria-labelledby="queue-title">
          <header className="section-head">
            <h2 id="queue-title" className="section-name">
              Answer queue
            </h2>
            <span className="queue-count" aria-label={`${position} of ${ids.length}`}>
              {position} / {ids.length}
            </span>
          </header>
          <ul ref={listBox} className="queue-list">
            {ids.map((id) => {
              const s = byId.get(id)!;
              return <QueueItem key={id} session={s} selected={id === selectedId} waiting={waitingIds.has(id)} onSelect={() => select(id)} />;
            })}
          </ul>
          <p className="hint queue-keys">
            <Kbd>J</Kbd> <Kbd>K</Kbd> or arrows to move; the queue moves on by itself after an answer.
          </p>
        </section>

        {selected && (
          <section className="queue-detail" aria-label={`${selected.name}: ${kind ? REQUEST_BADGE[kind] : 'no longer waiting'}`}>
            <header className="ny-head">
              {kind && (
                <span className="ny-badge">
                  <StatusGlyph session={selected} size={12} />
                  {REQUEST_BADGE[kind]}
                </span>
              )}
              <h3 className="ny-name">{selected.name}</h3>
              {stillWaiting && <WaitClock since={p?.since ?? selected.statusSince} />}
            </header>

            {stillWaiting ? (
              (kind === 'permission' || kind === 'question') && (
                <div className="ny-request">
                  {p?.detail ? (
                    <code className="ny-code">
                      {p.tool && p.tool !== 'AskUserQuestion' && <span className="ny-tool">{p.tool}</span>} {p.detail}
                    </code>
                  ) : (
                    <p className="ny-message">{p?.message ?? 'Claude Code is waiting for a permission or an answer.'}</p>
                  )}
                  {canAnswer && <p className="ny-ask">{askLine(selected)}</p>}
                  {rule && (
                    <p className="ny-ask">
                      "Always in this area" adds the rule <code>{rule}</code> to {areaName}.
                    </p>
                  )}
                </div>
              )
            ) : (
              <div className="queue-moved" role="status">
                <p className="ny-message">No longer waiting. It stays here while you type in it.</p>
                <button type="button" onClick={() => select(ids.find((id) => waitingIds.has(id)) ?? null)}>
                  Next waiting session
                </button>
              </div>
            )}

            <div ref={terminalBox} className="queue-terminal">
              <SessionBody key={selected.id} session={selected} onFocusChange={(f) => onFocusChange(selected.id, f)} />
            </div>

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}

            <div className="queue-actions">
              {canAnswer && (
                <>
                  <button type="button" className="ny-primary" disabled={busy} aria-keyshortcuts="A" onClick={() => run('allow')}>
                    <Kbd>A</Kbd> Allow once
                  </button>
                  {rule && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-keyshortcuts="S"
                      title={`Allows it now, and adds the rule "${rule}" to ${areaName}: its sessions will run such commands without asking.`}
                      onClick={() => run('always')}
                    >
                      <Kbd>S</Kbd> Always in this area
                    </button>
                  )}
                  <button type="button" disabled={busy} aria-keyshortcuts="D" onClick={() => run('deny')}>
                    <Kbd>D</Kbd> Deny
                  </button>
                </>
              )}
              {kind === 'finished' && (
                <button type="button" className="ny-primary" onClick={() => void api.ackSession(selected.id).catch(() => undefined)}>
                  Mark as seen
                </button>
              )}
              <button type="button" aria-keyshortcuts="R" onClick={() => run('reply')}>
                <Kbd>R</Kbd> Reply in the terminal
              </button>
              <button type="button" aria-keyshortcuts="Enter" onClick={() => run('open')}>
                <Kbd>Enter</Kbd> Open terminal
              </button>
            </div>
          </section>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {selected ? `${position} of ${ids.length}: ${selected.name}, ${stillWaiting ? requestSummary(selected) : 'no longer waiting'}` : ''}
      </p>
    </div>
  );
}

function WaitClock({ since }: { since: number }): React.JSX.Element {
  const now = useNow(1000);
  const clock = waitClock(now - since);
  return (
    <span className="ny-clock" aria-label={`waiting for ${clock}`}>
      {clock}
    </span>
  );
}
