import { useEffect, useId, useRef, useState } from 'react';
import type { ConversationItem } from '../../shared/types.js';
import { api } from '../api.js';
import { useEscape } from '../escape.js';
import { requestPermissionOnce } from '../notify.js';
import { rankItems } from '../palette.js';
import { requestSummary } from '../requests.js';
import { selectAttention } from '../selectors.js';
import { sessionLine, shortAge } from '../session-text.js';
import { setView, useStore } from '../store.js';

interface Item {
  id: string;
  group: 'Session' | 'Area' | 'Action' | 'Launcher' | 'View' | 'Conversation';
  title: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

const report = (e: unknown): void => window.alert((e as Error).message);

/**
 * Ctrl K: jump to a session, an area or a view, start a launcher, resume a conversation, or
 * run an action, by typing a few letters of it. Arrows move, Enter runs, Escape closes.
 */
export function CommandPalette(props: { onClose: () => void; onNewSession: () => void; onNewArea: () => void; onTicket: () => void }): React.JSX.Element {
  const { sessions, stories, meta, activity } = useStore();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(typeof document !== 'undefined' ? document.activeElement : null);

  const close = (): void => {
    props.onClose();
    // Back where the user was, unless what runs takes them elsewhere.
    const back = returnTo.current;
    if (back instanceof HTMLElement && back.isConnected) setTimeout(() => back.focus(), 0);
  };
  useEscape(close);

  useEffect(() => {
    input.current?.focus();
    api
      .conversations()
      .then((list) => setConversations(list.filter((c) => !c.openIn).slice(0, 30)))
      .catch(() => undefined);
  }, []);

  const now = Date.now();
  const waiting = selectAttention(sessions);
  const waitingIds = new Set(waiting.map((s) => s.id));
  const ordered = [...waiting, ...sessions.filter((s) => !waitingIds.has(s.id))];
  const items: Item[] = [
    ...ordered.map(
      (s): Item => ({
        id: `s-${s.id}`,
        group: 'Session',
        title: s.name,
        hint: waitingIds.has(s.id) ? `${requestSummary(s)} — waiting ${shortAge(now - (s.pending?.since ?? s.statusSince))}` : sessionLine(s, activity[s.id] ?? 0),
        keywords: `${stories.find((a) => a.id === s.storyId)?.name ?? ''} ${stories.find((a) => a.id === s.storyId)?.ticket ?? ''} ${s.git?.branch ?? ''}`,
        run: () => setView({ kind: 'single', id: s.id }),
      }),
    ),
    { id: 'a-queue', group: 'Action', title: 'Answer queue', hint: `${waiting.length} waiting`, keywords: 'needs attention permission', run: () => setView({ kind: 'attention' }) },
    { id: 'a-new', group: 'Action', title: 'New session', run: props.onNewSession },
    { id: 'a-ticket', group: 'Action', title: 'Start from ticket', hint: 'worktree, area and sessions', keywords: 'new area recipe', run: props.onTicket },
    { id: 'a-area', group: 'Action', title: 'New area', run: props.onNewArea },
    ...stories.map(
      (a): Item => ({
        id: `ar-${a.id}`,
        group: 'Area',
        title: a.name,
        hint: [a.ticket, a.cwd].filter(Boolean).join(' · '),
        keywords: a.ticket,
        run: () => setView({ kind: 'grid', storyFilter: a.id }),
      }),
    ),
    ...stories
      .filter((a) => a.cwd)
      .map(
        (a): Item => ({
          id: `code-${a.id}`,
          group: 'Action',
          title: `Open ${a.cwd} in VS Code`,
          hint: a.name,
          keywords: `${a.name} ${a.ticket} editor`,
          run: () => void api.openAreaEditor(a.id).catch(report),
        }),
      ),
    ...meta.profiles.map(
      (p): Item => ({
        id: `p-${p.id}`,
        group: 'Launcher',
        title: `Start ${p.name}`,
        keywords: 'launch new',
        run: () => {
          if (p.kind === 'claude') requestPermissionOnce();
          api
            .createSession({ profileId: p.id })
            .then((s) => setView({ kind: 'single', id: s.id }))
            .catch(report);
        },
      }),
    ),
    { id: 'v-board', group: 'View', title: 'Board', run: () => setView({ kind: 'board' }) },
    { id: 'v-grid', group: 'View', title: 'Terminals', keywords: 'wall grid', run: () => setView({ kind: 'grid' }) },
    { id: 'v-conv', group: 'View', title: 'Conversations', run: () => setView({ kind: 'conversations' }) },
    { id: 'v-sched', group: 'View', title: 'Schedules', run: () => setView({ kind: 'schedules' }) },
    { id: 'v-usage', group: 'View', title: 'Usage', keywords: 'cost limits flow', run: () => setView({ kind: 'usage' }) },
    ...conversations.map(
      (c): Item => ({
        id: `c-${c.id}`,
        group: 'Conversation',
        title: `Resume “${c.title}”`,
        hint: c.cwd,
        run: () => {
          requestPermissionOnce();
          api
            .createSession({ resume: c.id })
            .then((s) => setView({ kind: 'single', id: s.id }))
            .catch(report);
        },
      }),
    ),
  ];

  const shown = rankItems(items, query, 40);
  const index = Math.min(active, Math.max(0, shown.length - 1));
  const optionId = (i: number): string => `${listId}-opt-${i}`;

  useEffect(() => {
    document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' });
  });

  const run = (item: Item | undefined): void => {
    if (!item) return;
    props.onClose();
    item.run();
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length === 0) return;
      setActive((index + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[index]);
    } else if (e.key === 'Tab') {
      // The palette keeps the focus while it is open.
      e.preventDefault();
    }
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <span aria-hidden="true">›</span>
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown.length > 0 ? optionId(index) : undefined}
            aria-label="Jump to a session, area or view, or run a command"
            placeholder="Jump to a session, area, ticket or run a command"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <ul id={listId} className="palette-list" role="listbox" aria-label="Results">
          {shown.map((item, i) => (
            <li
              key={item.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'palette-item active' : 'palette-item'}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== index && setActive(i)}
              onClick={() => run(item)}
            >
              <span className="palette-group">{item.group}</span>
              <span className="palette-text">
                <span className="palette-title">{item.title}</span>
                {item.hint && <span className="palette-hint">{item.hint}</span>}
              </span>
              {i === index && <kbd className="key">Enter</kbd>}
            </li>
          ))}
          {shown.length === 0 && (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              Nothing matches “{query}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
