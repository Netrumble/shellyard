import { useEffect, useRef, useState } from 'react';
import type { ClosedSession, SessionInfo, Story } from '../../shared/types.js';
import { api } from '../api.js';
import { areaSummary, boardAreas, type BoardArea } from '../board.js';
import { loadAreaSizes, NO_AREA_KEY, saveAreaSizes, withAreaSize, type AreaSize } from '../board-sizes.js';
import { lampState } from '../effects.js';
import { durationLabel } from '../gauges.js';
import { statusLabel } from '../selectors.js';
import { setView, useStore } from '../store.js';
import { StoryDialog } from './StoryDialog.js';

const DRAG_TYPE = 'application/x-cvm-session';
const report = (e: unknown): void => window.alert((e as Error).message);

/** One terminal on the board: a light for its state and its name. Not the terminal itself. */
function Dot({ session }: { session: SessionInfo }): React.JSX.Element {
  const label = `${session.name}: ${statusLabel(session)}`;
  return (
    <button
      type="button"
      className="board-dot"
      draggable
      title={`${label}. Click to open, drag to another area.`}
      aria-label={label}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, session.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => setView({ kind: 'single', id: session.id })}
    >
      <span className={`lamp lamp-${lampState(session)}`} aria-hidden="true" />
      <span className="board-dot-name">{session.name}</span>
      <span className="board-dot-status">{statusLabel(session)}</span>
    </button>
  );
}

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

function Area(props: {
  area: BoardArea;
  size: AreaSize | undefined;
  onResize: (size: AreaSize | null) => void;
  onNewSession: (storyId?: string) => void;
  onEdit: (story: Story) => void;
}): React.JSX.Element {
  const { area, size, onNewSession, onEdit } = props;
  const { story, sessions } = area;
  const [over, setOver] = useState(false);
  const [reopening, setReopening] = useState(false);
  const closedCount = useStore().closed.length;
  const name = story ? story.name : 'No area';
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
      className={`board-area area-${area.state}${over ? ' drop-over' : ''}${story ? '' : ' area-none'}`}
      aria-label={`${name}: ${areaSummary(sessions)}`}
      style={{ ...(story?.color ? { '--area-color': story.color } : {}), ...(size ? { width: size.width, height: size.height } : {}) } as React.CSSProperties}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setOver(false);
        if (!id) return;
        e.preventDefault();
        const target = story ? story.id : null;
        if (sessions.some((s) => s.id === id)) return;
        api.moveSession(id, target).catch(report);
      }}
    >
      <header className="board-area-head">
        <button
          type="button"
          className="board-area-title"
          title="Open all the terminals of this area"
          onClick={() => setView({ kind: 'grid', storyFilter: story ? story.id : null })}
        >
          <span className="board-area-name">{name}</span>
          {story?.ticket && <span className="model">{story.ticket}</span>}
        </button>
        <span className="actions">
          <button type="button" className="icon" title="New session in this area" aria-label={`New session in ${name}`} onClick={() => onNewSession(story?.id)}>
            +
          </button>
          <button
            type="button"
            className="icon"
            title="Reopen a closed session in this area"
            aria-label={`Reopen a closed session in ${name}`}
            aria-expanded={reopening}
            disabled={closedCount === 0 && !reopening}
            onClick={() => setReopening((v) => !v)}
          >
            ↺
          </button>
          {size && (
            <button type="button" className="icon" title="Back to the default size" aria-label={`Reset the size of ${name}`} onClick={() => props.onResize(null)}>
              ⤡
            </button>
          )}
          {story && (
            <>
              <button type="button" className="icon" title="Rename or edit this area" aria-label={`Rename or edit ${name}`} onClick={() => onEdit(story)}>
                ✎
              </button>
              <button type="button" className="icon" title="Delete area" aria-label={`Delete ${name}`} onClick={remove}>
                ✕
              </button>
            </>
          )}
        </span>
      </header>
      {reopening && <ClosedList story={story} onDone={() => setReopening(false)} />}
      <div className="board-dots">
        {sessions.map((s) => (
          <Dot key={s.id} session={s} />
        ))}
        {sessions.length === 0 && <p className="hint">{story ? 'No sessions yet. Start one with +, or drag one here.' : 'Drag a session here to take it out of its area.'}</p>}
      </div>
      <footer className="board-area-foot">{areaSummary(sessions)}</footer>
    </section>
  );
}

/**
 * The work seen from above: one box per area, one light per terminal. An area lights up when
 * one of its terminals is waiting, so a glance tells who needs attention and where.
 */
export function BoardView({ onNewSession }: { onNewSession: (storyId?: string) => void }): React.JSX.Element {
  const { sessions, stories, loaded } = useStore();
  const [dialog, setDialog] = useState<{ story?: Story } | null>(null);
  const [sizes, setSizes] = useState(loadAreaSizes);
  const areas = boardAreas(sessions, stories);
  const resize = (key: string, size: AreaSize | null): void => {
    setSizes((current) => {
      const next = withAreaSize(current, key, size);
      saveAreaSizes(next);
      return next;
    });
  };

  return (
    <div className="board">
      <div className="view-tools">
        <button type="button" onClick={() => setDialog({})}>
          New area
        </button>
        <span className="hint">Drag the corner of an area to resize it.</span>
      </div>
      {loaded && areas.length === 0 && (
        <p className="empty">Nothing here yet. Create an area for a piece of work, then start sessions in it.</p>
      )}
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
      {dialog && <StoryDialog story={dialog.story} onClose={() => setDialog(null)} />}
    </div>
  );
}
