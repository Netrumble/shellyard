import { useState } from 'react';
import type { Profile, SessionInfo, Story } from '../../shared/types.js';
import { api } from '../api.js';
import { requestPermissionOnce } from '../notify.js';
import { groupByStory, selectCounts } from '../selectors.js';
import { setView, useStore } from '../store.js';
import { Tachometer } from './Cluster.js';
import { ColorDot, SessionActions, StatusBadge } from './SessionBits.js';
import { ProfileDialog } from './ProfileDialog.js';
import { StoryDialog } from './StoryDialog.js';

const COLLAPSED_KEY = 'cvm-collapsed-stories';

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

function SessionRow({ session, selected }: { session: SessionInfo; selected: boolean }): React.JSX.Element {
  return (
    <li className={selected ? 'selected' : undefined}>
      <button type="button" className="session-link" onClick={() => setView({ kind: 'single', id: session.id })}>
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

export function Sidebar({ onNewSession }: { onNewSession: (storyId?: string) => void }): React.JSX.Element {
  const { sessions, stories, schedules, view, meta } = useStore();
  const counts = selectCounts(sessions);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [storyDialog, setStoryDialog] = useState<{ story?: Story } | null>(null);
  const [profileDialog, setProfileDialog] = useState<string | null>(null);
  const editedProfile = meta.profiles.find((p) => p.id === profileDialog);
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
    <aside className="sidebar">
      <div className="brand">TTC</div>

      <nav>
        <button type="button" className={view.kind === 'board' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'board' })}>
          <span>Board</span>
        </button>
        <button type="button" className={view.kind === 'attention' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'attention' })}>
          <span>Needs attention</span>
          {counts.attention > 0 && <span className="count">{counts.attention}</span>}
        </button>
        <button type="button" className={view.kind === 'grid' && storyFilter === undefined ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'grid' })}>
          <span>Terminals</span>
          <span className="count quiet">{sessions.length}</span>
        </button>
        <button type="button" className={view.kind === 'conversations' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'conversations' })}>
          <span>Conversations</span>
        </button>
        <button type="button" className={view.kind === 'schedules' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'schedules' })}>
          <span>Schedules</span>
          {activeSchedules > 0 && <span className="count quiet">{activeSchedules}</span>}
        </button>
        <button type="button" className={view.kind === 'usage' ? 'nav active' : 'nav'} onClick={() => setView({ kind: 'usage' })}>
          <span>Usage</span>
        </button>
      </nav>

      <div className="new-buttons">
        <button type="button" className="start" onClick={() => onNewSession()}>
          <span className="start-ring" aria-hidden="true">
            <span className="start-core" />
          </span>
          <span>New session</span>
        </button>
        <button type="button" className="new-story" onClick={() => setStoryDialog({})}>
          New area
        </button>
      </div>

      <h2>Sessions</h2>
      {groups.length === 0 && <p className="hint">No sessions yet.</p>}
      {groups.map((g) => {
        const key = g.story?.id ?? '';
        const folded = g.story !== null && collapsed.has(g.story.id);
        const active = view.kind === 'grid' && storyFilter === (g.story ? g.story.id : null);
        return (
          <section key={key} className="story">
            {g.story ? (
              <header className={active ? 'story-header active' : 'story-header'}>
                <button type="button" className="icon fold" aria-expanded={!folded} aria-label={`${folded ? 'Expand' : 'Collapse'} ${g.story.name}`} onClick={() => toggle(g.story!.id)}>
                  {folded ? '▸' : '▾'}
                </button>
                <button type="button" className="story-name" title="Show this area's terminals" onClick={() => setView({ kind: 'grid', storyFilter: g.story!.id })}>
                  {g.story.color && <ColorDot color={g.story.color} />}
                  <span className="session-name">{g.story.name}</span>
                  {g.story.ticket && <span className="model">{g.story.ticket}</span>}
                </button>
                {g.attention > 0 && (
                  <span className="count" title={`${g.attention} waiting for you`}>
                    {g.attention}
                  </span>
                )}
                <span className="actions">
                  <button type="button" className="icon" title="New session in this area" aria-label={`New session in ${g.story.name}`} onClick={() => onNewSession(g.story!.id)}>
                    +
                  </button>
                  <button type="button" className="icon" title="Rename or edit this area" aria-label={`Edit ${g.story.name}`} onClick={() => setStoryDialog({ story: g.story! })}>
                    ✎
                  </button>
                  <button type="button" className="icon" title="Delete area" aria-label={`Delete ${g.story.name}`} onClick={() => removeStory(g.story!, g.sessions)}>
                    ✕
                  </button>
                </span>
              </header>
            ) : (
              stories.length > 0 && (
                <header className={active ? 'story-header active' : 'story-header'}>
                  <button type="button" className="story-name loose" onClick={() => setView({ kind: 'grid', storyFilter: null })}>
                    <span className="session-name">No area</span>
                  </button>
                  {g.attention > 0 && <span className="count">{g.attention}</span>}
                </header>
              )
            )}
            {!folded && (
              <ul className={g.story ? 'session-list nested' : 'session-list'}>
                {g.sessions.map((s) => (
                  <SessionRow key={s.id} session={s} selected={selectedId === s.id} />
                ))}
                {g.story && g.sessions.length === 0 && <li className="hint empty-story">No sessions</li>}
              </ul>
            )}
          </section>
        );
      })}

      <h2>Profiles</h2>
      {meta.profiles.length === 0 && <p className="hint">No profiles found.</p>}
      <ul className="profile-list">
        {meta.profiles.map((p) => (
          <li key={p.id} className="profile-row">
            <button type="button" className="profile" title={`Start ${p.name}`} onClick={() => launch(p)}>
              <ColorDot color={p.color} />
              <span>{p.name}</span>
              <span className="go" aria-hidden="true">
                ▸
              </span>
            </button>
            <button type="button" className="icon" title="Edit this profile: start folder and terminal background" aria-label={`Edit the profile ${p.name}`} onClick={() => setProfileDialog(p.id)}>
              ✎
            </button>
          </li>
        ))}
      </ul>

      <p className="powered-by">Powered by Talentia Software</p>

      {storyDialog && <StoryDialog story={storyDialog.story} onClose={() => setStoryDialog(null)} />}
      {editedProfile && <ProfileDialog profile={editedProfile} onClose={() => setProfileDialog(null)} />}
    </aside>
  );
}
