import type { SessionInfo } from '../../shared/types.js';
import { glyphLabel, glyphOf, spinSeconds, type Glyph } from '../status-glyph.js';
import { useStore } from '../store.js';

/** The drawing of each glyph on a 16 by 16 grid; the colours come from theme.css. */
function Shape({ glyph }: { glyph: Glyph }): React.JSX.Element {
  switch (glyph) {
    case 'needs':
    case 'maybe':
      return <path className="glyph-mark" d="M8 1.6 14.4 8 8 14.4 1.6 8Z" />;
    case 'working':
      // Three quarters of a ring: the gap is what shows it turning.
      return <path className="glyph-mark" d="M8 2.75A5.25 5.25 0 1 1 2.75 8" />;
    case 'finished':
      return (
        <>
          <circle className="glyph-mark" cx="8" cy="8" r="6.4" />
          <path className="glyph-check" d="M5.1 8.2 7.1 10.2 11 6.2" />
        </>
      );
    case 'idle':
      return <circle className="glyph-mark" cx="8" cy="8" r="5.4" />;
    case 'exited':
      return <rect className="glyph-mark" x="3" y="3" width="10" height="10" rx="1.5" />;
  }
}

/** A glyph on its own, standing for a state rather than for a session (in counts, in legends). */
export function GlyphMark({ glyph, size = 14 }: { glyph: Glyph; size?: number }): React.JSX.Element {
  return (
    <span className={`glyph glyph-${glyph}`} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <Shape glyph={glyph} />
      </svg>
    </span>
  );
}

/**
 * The state of a session as a shape. Where the state is not written next to it, pass
 * `labelled` so that it is announced; otherwise it is decoration and stays silent.
 */
export function StatusGlyph({ session, labelled = false, size = 16 }: { session: SessionInfo; labelled?: boolean; size?: number }): React.JSX.Element {
  const { activity } = useStore();
  const rate = activity[session.id] ?? 0;
  const glyph = glyphOf(session, rate);
  const spin = glyph === 'working' ? spinSeconds(rate) : null;
  const a11y = labelled ? { role: 'img', 'aria-label': glyphLabel(glyph) } : { 'aria-hidden': true as const };
  return (
    <span
      className={`glyph glyph-${glyph}${spin !== null ? ' glyph-spinning' : ''}`}
      style={spin !== null ? ({ '--glyph-spin': `${spin}s` } as React.CSSProperties) : undefined}
      {...a11y}
    >
      <svg width={size} height={size} viewBox="0 0 16 16" focusable="false" aria-hidden="true">
        <Shape glyph={glyph} />
      </svg>
    </span>
  );
}
