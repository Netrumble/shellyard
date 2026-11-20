import { answerTime, blockedTime, compareAnswer, compareBlocked, type Comparison } from '../flow-text.js';
import { useStore } from '../store.js';
import { useFlow } from '../use-flow.js';

function Card({ caption, value, note, compare }: { caption: string; value: string; note?: string; compare?: Comparison | null }): React.JSX.Element {
  return (
    <div className="flow-card">
      <dt className="flow-caption">{caption}</dt>
      <dd className="flow-value">{value}</dd>
      {compare && <dd className={compare.better ? 'flow-compare better' : 'flow-compare'}>{compare.text}</dd>}
      {note && <dd className="flow-note">{note}</dd>}
    </div>
  );
}

/**
 * How the day went for the user, next to what it cost: the time sessions spent blocked on them,
 * how fast they answered, how many sessions worked at once, and what the area rules answered.
 */
export function FlowCards(): React.JSX.Element {
  const flow = useFlow();
  const { rules } = useStore();
  const autoApproved = rules.reduce((n, r) => n + r.weekHits, 0);
  const today = flow?.today;
  return (
    <section className="flow" aria-labelledby="flow-title">
      <header className="section-head">
        <h2 id="flow-title" className="section-name">
          Your flow today
        </h2>
        <span className="hint">Claude sessions started here; nothing leaves this computer</span>
      </header>
      <dl className="flow-cards">
        <Card caption="Blocked on you" value={today ? blockedTime(today.blockedMs) : '—'} compare={today ? compareBlocked(today.blockedMs, flow?.previous?.blockedMs ?? null) : null} />
        <Card
          caption="Median answer"
          value={today ? answerTime(today.medianAnswerMs) : '—'}
          note={today ? `${today.answers} answer${today.answers === 1 ? '' : 's'}` : undefined}
          compare={today ? compareAnswer(today.medianAnswerMs, flow?.previous?.medianAnswerMs ?? null) : null}
        />
        <Card caption="In parallel" value={today?.parallel != null ? String(today.parallel) : '—'} note="sessions working on average, while any did" />
        <Card caption="Auto-approved" value={String(autoApproved)} note="by area rules, this week" />
      </dl>
    </section>
  );
}
