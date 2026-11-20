import type { FlowSummary } from '../../shared/types.js';
import { answerTime, blockedTime, timelineBars, timelineSummary } from '../flow-text.js';
import { setView, useStore } from '../store.js';

const TICKS = ['−60m', '−45m', '−30m', '−15m', 'now'];

/**
 * The last hour of every Claude session, one bar each: where the time went, and where it
 * waited on you. Read from the server's log, so it survives reloading the page.
 */
export function TimelineView({ flow }: { flow: FlowSummary | null }): React.JSX.Element {
  const { sessions } = useStore();
  if (!flow) return <p className="empty">Loading…</p>;
  const { from, to } = flow.timeline;
  const rows = flow.timeline.sessions;
  const open = new Set(sessions.map((s) => s.id));
  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <header className="section-head">
        <h2 id="timeline-title" className="section-name">
          Last 60 minutes
        </h2>
        <span className="hint">Where did the waiting go?</span>
      </header>
      {rows.length === 0 ? (
        <p className="empty">No Claude session in the last hour.</p>
      ) : (
        <>
          <ul className="tl-rows">
            {rows.map((r) => {
              const summary = timelineSummary(r.segments, from, to) || 'no activity';
              return (
                <li key={r.id} className="tl-row">
                  {open.has(r.id) ? (
                    <button type="button" className="tl-name" title={`Open ${r.name}`} onClick={() => setView({ kind: 'single', id: r.id })}>
                      {r.name}
                    </button>
                  ) : (
                    <span className="tl-name tl-closed">{r.name} (closed)</span>
                  )}
                  <div className="tl-track" role="img" aria-label={`${r.name}: ${summary}`}>
                    {timelineBars(r.segments, from, to).map((b, i) => (
                      <span key={i} className={`tl-bar tl-${b.state}`} style={{ left: `${b.left}%`, width: `${b.width}%` }} />
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="tl-axis" aria-hidden="true">
            {TICKS.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <ul className="tl-legend" aria-label="Legend">
            <li>
              <span className="tl-swatch tl-needs" /> waiting for you
            </li>
            <li>
              <span className="tl-swatch tl-working" /> working
            </li>
            <li>
              <span className="tl-swatch tl-finished" /> finished
            </li>
            <li>
              <span className="tl-swatch tl-idle" /> idle
            </li>
          </ul>
        </>
      )}
      <p className="tl-foot">
        Today: <strong>{blockedTime(flow.today.blockedMs)}</strong> of sessions blocked on you · median answer time <strong>{answerTime(flow.today.medianAnswerMs)}</strong>
      </p>
    </section>
  );
}
