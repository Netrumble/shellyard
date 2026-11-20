import type { SessionInfo } from '../../shared/types.js';
import { SESSION_DRAG } from '../drag.js';
import { dropSessionOnSession } from '../drag-actions.js';
import { sessionLine, shortAge } from '../session-text.js';
import { sparkPath } from '../sparkline.js';
import { setView, useStore } from '../store.js';
import { useNow } from './Cluster.js';
import { dragSource, useDropTarget } from './drag-target.js';
import { StatusGlyph } from './StatusGlyph.js';

const SPARK_W = 72;
const SPARK_H = 20;

/** The last minutes of output, as a line. Decoration: the row says the state in words. */
function Sparkline({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { sparks, effects } = useStore();
  if (effects === 'off') return null;
  return (
    <svg className="spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true" focusable="false">
      <path d={sparkPath(sparks.series[sessionId], SPARK_W, SPARK_H)} />
    </svg>
  );
}

/**
 * One session on the board: its state, name, what it does and with which model, its recent
 * output and how long it has been in this state. Click to open; drag to another area or next
 * to another session.
 */
export function SessionRow({ session }: { session: SessionInfo }): React.JSX.Element {
  const { activity } = useStore();
  const now = useNow(1000);
  const line = sessionLine(session, activity[session.id] ?? 0);
  const age = shortAge(now - session.statusSince);
  // The rows stack, so the top half of a row drops before it and the bottom half after.
  const { dropClass, dropProps } = useDropTarget({ [SESSION_DRAG]: { placed: true, targetId: session.id, onDrop: (id, place) => dropSessionOnSession(id, session.id, place) } });
  return (
    <li className={dropClass ? `srow-item ${dropClass}` : 'srow-item'} {...dropProps}>
      <button
        type="button"
        className="srow"
        title={`${session.name}. Click to open, drag to another area or next to another session.`}
        aria-label={`${session.name}: ${line}, for ${age}`}
        {...dragSource(SESSION_DRAG, session.id)}
        onClick={() => setView({ kind: 'single', id: session.id })}
      >
        <StatusGlyph session={session} size={18} />
        <span className="srow-text">
          <span className="srow-name">{session.name}</span>
          <span className="srow-line">{line}</span>
        </span>
        <Sparkline sessionId={session.id} />
        <span className="srow-age">{age}</span>
      </button>
    </li>
  );
}
