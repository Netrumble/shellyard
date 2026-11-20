import { useEffect, useRef, useState } from 'react';
import type { ClosedSession, Story } from '../../shared/types.js';
import { api } from '../api.js';
import { areaBranch, areaSummary, boardAreas, byActivity, glyphCounts, type BoardArea, type GlyphCounts } from '../board.js';
import { loadAreaSizes, NO_AREA_KEY, saveAreaSizes, withAreaSize, type AreaSize } from '../board-sizes.js';
import { AREA_DRAG, SESSION_DRAG } from '../drag.js';
import { dropArea, dropSessionOnArea, sessionInArea } from '../drag-actions.js';
import { durationLabel } from '../gauges.js';
import { setView, useStore } from '../store.js';
import { dragSource, useDropTarget } from './drag-target.js';
import { MoreIcon } from './icons.js';
import { NeedsYouLane } from './NeedsYouLane.js';
import { Popover } from './Popover.js';
import { RulesDialog } from './RulesDialog.js';
import { SelectionBar } from './SelectionBar.js';
import { SessionRow } from './SessionRow.js';
import { StoryDialog } from './StoryDialog.js';

const report = (e: unknown): void => window.alert((e as Error).message);

/**
 * The sessions that can be opened again in an area: those closed in it first, then those
 * closed anywhere else, which reopening here moves into this area.
 */
function ClosedList({ story, onDone }: { story: Story | null; onDone: () => void }): React.JSX.Element {
  const { closed, stories } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaId = story ? story.id : null;
  const known = new Set(stories.map((s) => s.id));
  const homeOf = (c: ClosedSession): string | null => (c.storyId && known.has(c.storyId) ? c.storyId : null);
  const here = closed.filter((c) => homeOf(c) === areaId);
  const elsewhere = closed.filter((c) => homeOf(c) !== areaId);
  const now = Date.now();
  const areaName = (c: ClosedSession): string => stories.find((s) => s.id === homeOf(c))?.name ?? 'no area';

  const reopen = async (c: ClosedSession): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.reopenClosed(c.id, areaId);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (c: ClosedSession, from: string | null): React.JSX.Element => (
    <li key={c.id}>
      <span className="closed-text">
        <strong>{c.name}</strong>
        <span className="hint">
          {c.resumes ? 'continues its conversation' : c.kind === 'claude' ? 'starts a new conversation' : 'new shell in the same folder'}
          {', closed '}
          {now - c.closedAt < 60_000 ? 'just now' : `${durationLabel(now - c.closedAt)} ago`}
          {from !== null && `, from ${from}`}
        </span>
      </span>
      <button type="button" disabled={busy} onClick={() => void reopen(c)}>
        Reopen here
      </button>
      <button type="button" className="icon" title="Forget this one" aria-label={`Forget ${c.name}`} onClick={() => api.forgetClosed(c.id).catch(report)}>
        ✕
      </button>
    </li>
  );

  return (
    <div className="closed-list">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {closed.length === 0 && <p className="hint">No closed sessions to reopen.</p>}
      {here.length > 0 && <ul>{here.map((c) => row(c, null))}</ul>}
      {elsewhere.length > 0 && (
        <>
          <p className="closed-divider">Closed in other areas</p>
          <ul>{elsewhere.map((c) => row(c, areaName(c)))}</ul>
        </>
      )}
    </div>
  );
}

/** A thin bar split by state: how much of the area waits, works, has finished or rests. */
function StateBar({ counts, label }: { counts: GlyphCounts; label: string }): React.JSX.Element {
  const parts = (['needs', 'working', 'finished'] as const).filter((g) => counts[g] > 0);
  const total = counts.needs + counts.working + counts.finished + counts.idle + counts.exited;
  return (
    <div className="state-bar" role="img" aria-label={label}>
      {total > 0 && parts.map((g) => <span key={g} className={`state-bar-${g}`} style={{ flexGrow: counts[g] }} />)}
      {total > 0 && <span className="state-bar-rest" style={{ flexGrow: counts.idle + counts.exited }} />}
    </div>
  );
}

function Area(props: {
  area: BoardArea;
  size: AreaSize | undefined;
  onResize: (size: AreaSize | null) => void;
  onNewSession: (storyId?: string) => void;
  onEdit: (story: Story) => void;
}): React.JSX.Element {
  const { area, size, onNewSession, onEdit } = props;
  const { story, sessions } = area;
  const { activity, closed, rules } = useStore();
  const ruleCount = story ? rules.filter((r) => r.storyId === story.id).length : 0;
  const [rulesOpen, setRulesOpen] = useState(false);
  // A session dropped on the area moves into it; an area dropped on it goes to its left or right.
  const { dropClass, dropProps } = useDropTarget(
    {
      [AREA_DRAG]: story ? { placed: true, targetId: story.id, onDrop: (id, place) => dropArea(id, story.id, place) } : undefined,
      [SESSION_DRAG]: { skip: (id) => sessionInArea(id, story ? story.id : null), onDrop: (id) => dropSessionOnArea(id, story ? story.id : null) },
    },
    'x',
  );
  const [reopening, setReopening] = useState(false);
  const name = story ? story.name : 'No area';
  const summary = areaSummary(sessions);
  const branch = areaBranch(sessions);
  const box = useRef<HTMLElement>(null);
  const onResize = useRef(props.onResize);
  onResize.current = props.onResize;
  const known = useRef(size);
  known.current = size;

  // The browser resizes the box itself (the corner handle) and writes the new size on the
  // element; this notices that and has it remembered. A box growing with its content is not
  // a resize: only a height the user set is on the element.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!el.style.height) return;
        const now = { width: el.offsetWidth, height: el.offsetHeight };
        const was = known.current;
        if (was && Math.abs(was.width - now.width) < 2 && Math.abs(was.height - now.height) < 2) return;
        onResize.current(now);
      }, 150);
    });
    observer.observe(el);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const remove = (): void => {
    if (!story) return;
    const running = sessions.filter((s) => s.status !== 'exited').length;
    const question =
      running > 0
        ? `Delete the area "${story.name}"? Its ${running} running session${running === 1 ? '' : 's'} will keep running, with no area.`
        : `Delete the area "${story.name}"?`;
    if (window.confirm(question)) api.deleteStory(story.id).catch(report);
  };

  return (
    <section
      ref={box}
      className={`board-area area-${area.state}${dropClass ? ` ${dropClass}` : ''}${story ? '' : ' area-none'}`}
      aria-label={`${name}: ${summary}`}
      style={{ ...(story?.color ? { '--area-color': story.color } : {}), ...(size ? { width: size.width, height: size.height } : {}) } as React.CSSProperties}
      {...dropProps}
    >
      <header className="area-head">
        <button
          type="button"
          className="area-title"
          title={story ? 'Open all the terminals of this area; drag to reorder the areas' : 'Open all the terminals of this area'}
          {...(story ? dragSource(AREA_DRAG, story.id) : {})}
          onClick={() => setView({ kind: 'grid', storyFilter: story ? story.id : null })}
        >
          <span className="area-swatch" aria-hidden="true" />
          <span className="area-name">{name}</span>
        </button>
        {story?.ticket && <span className="area-ticket">{story.ticket}</span>}
        <Popover label={`More actions for ${name}`} button={<MoreIcon size={18} />}>
          {(close) => (
            <div className="menu-panel">
              <button
                type="button"
                disabled={closed.length === 0}
                onClick={() => {
                  close();
                  setReopening(true);
                }}
              >
                Reopen a closed session
              </button>
              {story && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    onEdit(story);
                  }}
                >
                  Rename or edit the area
                </button>
              )}
              {story && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setRulesOpen(true);
                  }}
                >
                  Area rules{ruleCount > 0 ? ` (${ruleCount})` : ''}
                </button>
              )}
              {size && (
                <button
                  type="button"
                  onClick={() => {
                    close();
                    props.onResize(null);
                  }}
                >
                  Back to the default size
                </button>
              )}
              {story && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    close();
                    remove();
                  }}
                >
                  Delete the area
                </button>
              )}
            </div>
          )}
        </Popover>
      </header>
      {(story?.cwd || branch) && (
        <p className="area-where">
          {story?.cwd && <span className="area-path">{story.cwd}</span>}
          {story?.cwd && branch && <span aria-hidden="true"> · </span>}
          {branch && <span className="area-branch">{branch}</span>}
        </p>
      )}
      <StateBar counts={glyphCounts(sessions, activity)} label={summary} />
      {reopening && (
        <div className="area-reopen">
          <ClosedList story={story} onDone={() => setReopening(false)} />
          <button type="button" className="ny-link" onClick={() => setReopening(false)}>
            Close the list
          </button>
        </div>
      )}
      {sessions.length > 0 ? (
        <ul className="srows">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </ul>
      ) : (
        <p className="hint area-empty">{story ? 'No sessions yet. Start one, or drag one here.' : 'Drag a session here to take it out of its area.'}</p>
      )}
      <footer className="area-foot">
        <button type="button" className="area-action" onClick={() => onNewSession(story?.id)}>
          + Session
        </button>
        {story?.cwd && (
          <button type="button" className="area-action quiet" onClick={() => api.openAreaEditor(story.id).catch(report)}>
            Open in VS Code
          </button>
        )}
      </footer>
      {story && rulesOpen && <RulesDialog story={story} onClose={() => setRulesOpen(false)} />}
    </section>
  );
}

/** "11 sessions in 3 areas · 2 are waiting for you" */
function boardSummary(sessions: number, areas: number, waiting: number): string {
  const parts = [`${sessions} session${sessions === 1 ? '' : 's'} in ${areas} area${areas === 1 ? '' : 's'}`];
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for you`);
  return parts.join(' · ');
}

/**
 * The work seen from above: first what waits for the user, then one box per area, the busiest
 * first, each listing its sessions with their state and recent activity.
 */
export function BoardView({ onNewSession }: { onNewSession: (storyId?: string) => void }): React.JSX.Element {
  const { sessions, stories, loaded } = useStore();
  const [dialog, setDialog] = useState<{ story?: Story } | null>(null);
  const [sizes, setSizes] = useState(loadAreaSizes);
  const areas = byActivity(boardAreas(sessions, stories));
  const waiting = sessions.filter((s) => s.status === 'attention' && s.reason !== 'finished').length;
  const resize = (key: string, size: AreaSize | null): void => {
    setSizes((current) => {
      const next = withAreaSize(current, key, size);
      saveAreaSizes(next);
      return next;
    });
  };

  return (
    <div className="board">
      <div className="board-head">
        <p className="board-summary">{boardSummary(sessions.length, stories.length, waiting)}</p>
        <button type="button" onClick={() => setDialog({})}>
          New area
        </button>
      </div>
      <NeedsYouLane />
      <section className="board-section" aria-labelledby="areas-title">
        <header className="section-head">
          <h2 id="areas-title" className="section-name">
            Areas
          </h2>
          <span className="hint">Shift-click sessions to act on several · drag a session between areas · areas with activity float up</span>
        </header>
        {loaded && areas.length === 0 && <p className="empty">Nothing here yet. Create an area for a piece of work, then start sessions in it.</p>}
        <div className="board-areas">
          {areas.map((a) => (
            <Area
              key={a.story?.id ?? ''}
              area={a}
              size={sizes[a.story?.id ?? NO_AREA_KEY]}
              onResize={(size) => resize(a.story?.id ?? NO_AREA_KEY, size)}
              onNewSession={onNewSession}
              onEdit={(story) => setDialog({ story })}
            />
          ))}
        </div>
      </section>
      <SelectionBar />
      {dialog && <StoryDialog story={dialog.story} onClose={() => setDialog(null)} />}
    </div>
  );
}
