import { useState } from 'react';
import type { SessionInfo, Story } from '../../shared/types.js';
import { api } from '../api.js';
import { AREA_DRAG, SESSION_DRAG } from '../drag.js';
import { dropArea, dropSessionOnArea, dropSessionOnSession, sessionInArea } from '../drag-actions.js';
import { sidebarGroups, type StoryGroup } from '../selectors.js';
import { setView, useStore } from '../store.js';
import { branchLabel, chipText } from '../worktrees.js';
import { Tachometer } from './Cluster.js';
import { dragSource, useDropTarget } from './drag-target.js';
import { ColorDot, SessionActions, StatusBadge } from './SessionBits.js';

const COLLAPSED_KEY = 'shellyard-collapsed-stories';

/** Which stories are folded is a convenience of this browser, not shared state. */
function readCollapsed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Not remembered next time; nothing else depends on it.
  }
}

const report = (e: unknown): void => window.alert((e as Error).message);

/** Joins the class names that are set. */
const classes = (...names: Array<string | false | null | undefined>): string | undefined => names.filter(Boolean).join(' ') || undefined;

function SessionRow({ session, selected }: { session: SessionInfo; selected: boolean }): React.JSX.Element {
  const { dropClass, dropProps } = useDropTarget({ [SESSION_DRAG]: { placed: true, targetId: session.id, onDrop: (id, place) => dropSessionOnSession(id, session.id, place) } });
  return (
    <li className={classes(selected && 'selected', dropClass)} {...dropProps}>
      <button
        type="button"
        className="session-link"
        aria-current={selected ? 'page' : undefined}
        {...dragSource(SESSION_DRAG, session.id)}
        onClick={() => setView({ kind: 'single', id: session.id })}
      >
        <span className="row-top">
          {/* A dash, not a dot: dots mark the areas, so a session reads as an item under one. */}
          <span className="session-dash" style={{ background: session.color }} aria-hidden="true" />
          <span className="session-name">{session.name}</span>
          {session.status !== 'exited' && <Tachometer sessionId={session.id} />}
        </span>
        <span className="row-sub">
          <StatusBadge session={session} />
          {session.model && <span className="model">{session.model}</span>}
          {session.git && (
            <span className="model branch" title={chipText(session.git)}>
              {branchLabel(session.git)}
            </span>
          )}
        </span>
      </button>
      <SessionActions session={session} />
    </li>
  );
}

/**
 * One area in the sidebar: its header (dragged to reorder the areas; a session dropped on it
 * moves into the area) and its sessions. "No area" is neither dragged nor an area target.
 */
function AreaGroup(props: {
  group: StoryGroup;
  folded: boolean;
  active: boolean;
  showLooseHeader: boolean;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onNewSession: (storyId?: string) => void;
  onEdit: (story: Story) => void;
  onRemove: (story: Story, own: SessionInfo[]) => void;
}): React.JSX.Element {
  const { group: g, folded, active, selectedId } = props;
  const story = g.story;
  const areaId = story ? story.id : null;
  const intoArea = { skip: (id: string) => sessionInArea(id, areaId), onDrop: (id: string) => dropSessionOnArea(id, areaId) };
  const header = useDropTarget({
    [AREA_DRAG]: story ? { placed: true, targetId: story.id, onDrop: (id, place) => dropArea(id, story.id, place) } : undefined,
    [SESSION_DRAG]: intoArea,
  });
  const list = useDropTarget({ [SESSION_DRAG]: intoArea });
  return (
    <section
      className={story ? 'story' : 'story story-loose'}
      aria-label={story ? `Area ${story.name}` : 'Sessions with no area'}
      style={story?.color ? ({ '--area-color': story.color } as React.CSSProperties) : undefined}
    >
      {story ? (
        <header className={classes('story-header', active && 'active', header.dropClass)} {...header.dropProps}>
          <button type="button" className="icon fold" aria-expanded={!folded} aria-label={`${folded ? 'Expand' : 'Collapse'} ${story.name}`} onClick={() => props.onToggle(story.id)}>
            {folded ? '▸' : '▾'}
          </button>
          <button type="button" className="story-name" title="Show this area's terminals; drag to reorder the areas" {...dragSource(AREA_DRAG, story.id)} onClick={() => setView({ kind: 'grid', storyFilter: story.id })}>
            {story.color && <ColorDot color={story.color} />}
            <span className="session-name">{story.name}</span>
            {story.ticket && <span className="model">{story.ticket}</span>}
          </button>
          {g.attention > 0 && (
            <span className="count" title={`${g.attention} waiting for you`}>
              {g.attention}
            </span>
          )}
          <span className="actions">
            <button type="button" className="icon" title="New session in this area" aria-label={`New session in ${story.name}`} onClick={() => props.onNewSession(story.id)}>
              +
            </button>
            <button type="button" className="icon" title="Rename or edit this area" aria-label={`Edit ${story.name}`} onClick={() => props.onEdit(story)}>
              ✎
            </button>
            <button type="button" className="icon" title="Delete area" aria-label={`Delete ${story.name}`} onClick={() => props.onRemove(story, g.sessions)}>
              ✕
            </button>
          </span>
        </header>
      ) : (
        props.showLooseHeader && (
          <header className={classes('story-header', active && 'active', header.dropClass)} {...header.dropProps}>
            <button type="button" className="story-name loose" onClick={() => setView({ kind: 'grid', storyFilter: null })}>
              <span className="session-name">No area</span>
            </button>
            {g.attention > 0 && <span className="count">{g.attention}</span>}
          </header>
        )
      )}
      {!folded && (
        <ul className={classes('session-list', story && 'nested', list.dropClass)} {...list.dropProps}>
          {g.sessions.map((s) => (
            <SessionRow key={s.id} session={s} selected={selectedId === s.id} />
          ))}
          {story && g.sessions.length === 0 && <li className="hint empty-story">No sessions</li>}
          {!story && g.sessions.length === 0 && <li className="hint empty-story">Drop a session here to take it out of its area</li>}
        </ul>
      )}
    </section>
  );
}

/** The sessions in the sidebar, under their areas, as they were before the board took them over. */
export function SidebarSessions({ onNewSession, onEditArea }: { onNewSession: (storyId?: string) => void; onEditArea: (story: Story) => void }): React.JSX.Element {
  const { sessions, stories, view } = useStore();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const groups = sidebarGroups(sessions, stories);
  const selectedId = view.kind === 'single' ? view.id : null;
  const storyFilter = view.kind === 'grid' ? view.storyFilter : undefined;

  const toggle = (id: string): void => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    writeCollapsed(next);
  };

  const removeStory = (story: Story, own: SessionInfo[]): void => {
    const running = own.filter((s) => s.status !== 'exited').length;
    const question =
      running > 0
        ? `Delete the area "${story.name}"? Its ${running} running session${running === 1 ? '' : 's'} will keep running, with no area.`
        : `Delete the area "${story.name}"?`;
    if (window.confirm(question)) api.deleteStory(story.id).catch(report);
  };

  return (
    <div className="sessions-section">
      {groups.length === 0 && <p className="hint">No sessions yet.</p>}
      {groups.map((g) => (
        <AreaGroup
          key={g.story?.id ?? ''}
          group={g}
          folded={g.story !== null && collapsed.has(g.story.id)}
          active={view.kind === 'grid' && storyFilter === (g.story ? g.story.id : null)}
          showLooseHeader={stories.length > 0}
          selectedId={selectedId}
          onToggle={toggle}
          onNewSession={onNewSession}
          onEdit={onEditArea}
          onRemove={removeStory}
        />
      ))}
    </div>
  );
}
