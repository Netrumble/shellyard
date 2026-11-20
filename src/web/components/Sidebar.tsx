import { useState } from 'react';
import type { Profile, SessionInfo, Story } from '../../shared/types.js';
import { api } from '../api.js';
import { AREA_DRAG, LAUNCHER_DRAG, SESSION_DRAG } from '../drag.js';
import { dropArea, dropLauncher, dropSessionOnArea, dropSessionOnSession } from '../drag-actions.js';
import { requestPermissionOnce } from '../notify.js';
import { groupByStory, selectCounts, type StoryGroup } from '../selectors.js';
import { setView, useStore } from '../store.js';
import { Tachometer } from './Cluster.js';
import { dragSource, useDropTarget } from './drag-target.js';
import { LAUNCHERS_FOLDED_KEY, SESSIONS_FOLDED_KEY, SIDEBAR_FOLDED_KEY, readFlag, writeFlag } from '../sidebar-memory.js';
import {
  AttentionIcon,
  BoardIcon,
  ConversationsIcon,
  NewAreaIcon,
  NewSessionIcon,
  SchedulesIcon,
  SidebarIcon,
  TerminalsIcon,
  UsageIcon,
} from './icons.js';
import { ColorDot, SessionActions, StatusBadge } from './SessionBits.js';
import { ProfileDialog } from './ProfileDialog.js';
import { StoryDialog } from './StoryDialog.js';

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
  const { dropClass, dropProps } = useDropTarget({ [SESSION_DRAG]: { placed: true, onDrop: (id, place) => dropSessionOnSession(id, session.id, place) } });
  return (
    <li className={classes(selected && 'selected', dropClass)} {...dropProps}>
      <button type="button" className="session-link" {...dragSource(SESSION_DRAG, session.id)} onClick={() => setView({ kind: 'single', id: session.id })}>
        <span className="row-top">
          <ColorDot color={session.color} />
          <span className="session-name">{session.name}</span>
          {session.status !== 'exited' && <Tachometer sessionId={session.id} />}
        </span>
        <span className="row-sub">
          <StatusBadge session={session} />
          {session.model && <span className="model">{session.model}</span>}
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
  const intoArea = { onDrop: (id: string) => dropSessionOnArea(id, areaId) };
  const header = useDropTarget({
    [AREA_DRAG]: story ? { placed: true, onDrop: (id, place) => dropArea(id, story.id, place) } : undefined,
    [SESSION_DRAG]: intoArea,
  });
  const list = useDropTarget({ [SESSION_DRAG]: intoArea });
  return (
    <section className="story">
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
        </ul>
      )}
    </section>
  );
}

/** A launcher: click to start it, drag to reorder the launchers. */
function LauncherRow({ profile: p, onLaunch, onEdit }: { profile: Profile; onLaunch: (p: Profile) => void; onEdit: (id: string) => void }): React.JSX.Element {
  const { dropClass, dropProps } = useDropTarget({ [LAUNCHER_DRAG]: { placed: true, onDrop: (id, place) => dropLauncher(id, p.id, place) } });
  return (
    <li className={classes('profile-row', dropClass)} {...dropProps}>
      <button type="button" className="profile" title={`Start ${p.name}`} {...dragSource(LAUNCHER_DRAG, p.id)} onClick={() => onLaunch(p)}>
        <ColorDot color={p.color} />
        <span>{p.name}</span>
        <span className="go" aria-hidden="true">
          ▸
        </span>
      </button>
      <button type="button" className="icon" title="Edit this launcher: name, start folder and terminal look" aria-label={`Edit the launcher ${p.name}`} onClick={() => onEdit(p.id)}>
        ✎
      </button>
    </li>
  );
}

export function Sidebar({ onNewSession }: { onNewSession: (storyId?: string) => void }): React.JSX.Element {
  const { sessions, stories, schedules, view, meta } = useStore();
  const counts = selectCounts(sessions);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [railFolded, setRailFolded] = useState(() => readFlag(SIDEBAR_FOLDED_KEY));
  const [sessionsFolded, setSessionsFolded] = useState(() => readFlag(SESSIONS_FOLDED_KEY));
  const [launchersFolded, setLaunchersFolded] = useState(() => readFlag(LAUNCHERS_FOLDED_KEY));
  const [storyDialog, setStoryDialog] = useState<{ story?: Story } | null>(null);
  const [profileDialog, setProfileDialog] = useState<string | null>(null);
  const editedProfile = meta.profiles.find((p) => p.id === profileDialog);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const groups = groupByStory(sessions, stories);
  const selectedId = view.kind === 'single' ? view.id : null;
  const storyFilter = view.kind === 'grid' ? view.storyFilter : undefined;

  const toggle = (id: string): void => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    writeCollapsed(next);
  };

  const flip = (current: boolean, set: (v: boolean) => void, key: string): void => {
    set(!current);
    writeFlag(key, !current);
  };

  const launch = (p: Profile): void => {
    if (p.kind === 'claude') requestPermissionOnce();
    api
      .createSession({ profileId: p.id })
      .then((s) => setView({ kind: 'single', id: s.id }))
      .catch(report);
  };

  const removeStory = (story: Story, own: SessionInfo[]): void => {
    const running = own.filter((s) => s.status !== 'exited').length;
    const question =
      running > 0
        ? `Delete the area "${story.name}"? Its ${running} running session${running === 1 ? '' : 's'} will keep running, with no area.`
        : `Delete the area "${story.name}"?`;
    if (window.confirm(question)) api.deleteStory(story.id).catch(report);
  };

  const activeSchedules = schedules.filter((s) => s.enabled).length;

  return (
    <aside className={railFolded ? 'sidebar folded' : 'sidebar'}>
      <div className="sidebar-top">
        <button
          type="button"
          className="icon sidebar-toggle"
          aria-expanded={!railFolded}
          title={railFolded ? 'Unfold the sidebar' : 'Fold the sidebar'}
          aria-label={railFolded ? 'Unfold the sidebar' : 'Fold the sidebar'}
          onClick={() => flip(railFolded, setRailFolded, SIDEBAR_FOLDED_KEY)}
        >
          <SidebarIcon size={18} />
        </button>
        <div className="brand">ShellYard</div>
      </div>

      <nav>
        <button type="button" title="Board" aria-label="Board" className={view.kind === 'board' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'board' })}>
          <BoardIcon />
          <span className="nav-label">Board</span>
        </button>
        <button type="button" title="Needs attention" aria-label={counts.attention > 0 ? `Needs attention, ${counts.attention}` : 'Needs attention'} className={view.kind === 'attention' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'attention' })}>
          <AttentionIcon />
          <span className="nav-label">Needs attention</span>
          {counts.attention > 0 && <span className="count">{counts.attention}</span>}
        </button>
        <button type="button" title="Terminals" aria-label={`Terminals, ${sessions.length}`} className={view.kind === 'grid' && storyFilter === undefined ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'grid' })}>
          <TerminalsIcon />
          <span className="nav-label">Terminals</span>
          <span className="count quiet">{sessions.length}</span>
        </button>
        <button type="button" title="Conversations" aria-label="Conversations" className={view.kind === 'conversations' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'conversations' })}>
          <ConversationsIcon />
          <span className="nav-label">Conversations</span>
        </button>
        <button type="button" title="Schedules" aria-label={activeSchedules > 0 ? `Schedules, ${activeSchedules} active` : 'Schedules'} className={view.kind === 'schedules' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'schedules' })}>
          <SchedulesIcon />
          <span className="nav-label">Schedules</span>
          {activeSchedules > 0 && <span className="count quiet">{activeSchedules}</span>}
        </button>
        <button type="button" title="Usage" aria-label="Usage" className={view.kind === 'usage' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'usage' })}>
          <UsageIcon />
          <span className="nav-label">Usage</span>
        </button>
      </nav>

      <div className="new-buttons">
        <button type="button" className="start" title="New session" aria-label="New session" onClick={() => onNewSession()}>
          <span className="start-ring start-full" aria-hidden="true">
            <span className="start-core" />
          </span>
          <span className="start-compact">
            <NewSessionIcon />
          </span>
          <span className="start-label">New session</span>
        </button>
        <button type="button" className="new-story" onClick={() => setStoryDialog({})}>
          <NewAreaIcon />
          <span>New area</span>
        </button>
      </div>

      <h2 className="section-title">
        <button type="button" className="section-toggle" aria-expanded={!sessionsFolded} onClick={() => flip(sessionsFolded, setSessionsFolded, SESSIONS_FOLDED_KEY)}>
          <span aria-hidden="true">{sessionsFolded ? '▸' : '▾'}</span> Sessions
        </button>
      </h2>
      {!sessionsFolded && (
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
          onEdit={(story) => setStoryDialog({ story })}
          onRemove={removeStory}
        />
      ))}

        </div>
      )}

      <h2 className="section-title">
        <button type="button" className="section-toggle" aria-expanded={!launchersFolded} onClick={() => flip(launchersFolded, setLaunchersFolded, LAUNCHERS_FOLDED_KEY)}>
          <span aria-hidden="true">{launchersFolded ? '▸' : '▾'}</span> Launchers
        </button>
      </h2>
      {!launchersFolded && (
        <div className="launchers-section">
      {meta.profiles.length === 0 && <p className="hint">No launchers found.</p>}
      <ul className="profile-list">
        {meta.profiles.map((p) => (
          <LauncherRow key={p.id} profile={p} onLaunch={launch} onEdit={setProfileDialog} />
        ))}
      </ul>
      <button type="button" className="icon add-launcher" title="New launcher" aria-label="New launcher" onClick={() => setCreatingProfile(true)}>
        +
      </button>
        </div>
      )}

      <p className="powered-by">Powered by Talentia Software</p>

      {storyDialog && <StoryDialog story={storyDialog.story} onClose={() => setStoryDialog(null)} />}
      {editedProfile && <ProfileDialog profile={editedProfile} onClose={() => setProfileDialog(null)} />}
      {creatingProfile && <ProfileDialog onClose={() => setCreatingProfile(false)} />}
    </aside>
  );
}
