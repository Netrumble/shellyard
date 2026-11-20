import { useState } from 'react';
import type { UsageLine, UsagePeriod, UsageSummary } from '../../shared/types.js';
import { formatTokens, formatUsd, limitDisplay, zoneOf, type LimitDisplay } from '../gauges.js';
import { useStore } from '../store.js';
import { useNow } from './Cluster.js';
import { Dial } from './Dial.js';
import { FlowCards } from './FlowCards.js';
import { Odometer } from './Odometer.js';

type PeriodKey = 'today' | 'week' | 'month';
const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
];

function limitNote(d: LimitDisplay): string {
  if (d.state === 'no-data') return 'No reading yet. It arrives when a Claude Code session started here answers a prompt.';
  if (d.state === 'expired') return `This limit has reset since the last reading (${d.age}). Waiting for a new one.`;
  return `Resets in ${d.resetsIn}. Read ${d.age}.`;
}

function LimitDial({ label, d, hero }: { label: string; d: LimitDisplay; hero?: boolean }): React.JSX.Element {
  return (
    <figure className="usage-dial">
      <Dial size={hero ? 250 : 200} hero={hero} pct={d.pct} dead={d.state !== 'ok'} zone={zoneOf(d.pct)} label={label} valueText={d.state === 'ok' ? `${d.pct}%` : 'no data'} />
      <figcaption>{limitNote(d)}</figcaption>
    </figure>
  );
}

function Table({ caption, lines, tokens }: { caption: string; lines: UsageLine[]; tokens: boolean }): React.JSX.Element {
  return (
    <table className="usage-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{tokens ? 'Model' : 'Area'}</th>
          {tokens && <th scope="col" className="num">Tokens in</th>}
          {tokens && <th scope="col" className="num">Tokens out</th>}
          <th scope="col" className="num">Cost (est.)</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.key}>
            <th scope="row">{l.label}</th>
            {tokens && <td className="num">{formatTokens(l.tokensIn)}</td>}
            {tokens && <td className="num">{formatTokens(l.tokensOut)}</td>}
            <td className="num">{formatUsd(l.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const EMPTY: UsageSummary = {
  limits: { fiveHour: null, sevenDay: null, readAt: null },
  today: { costUsd: 0, byModel: [], byStory: [] },
  week: { costUsd: 0, byModel: [], byStory: [] },
  month: { costUsd: 0, byModel: [], byStory: [] },
};

/** Plan limits as dials, and what the sessions started here have cost, by model and by story. */
export function UsageView(): React.JSX.Element {
  const { usage } = useStore();
  const now = useNow();
  const [period, setPeriod] = useState<PeriodKey>('today');
  const u = usage ?? EMPTY;
  const five = limitDisplay(u.limits.fiveHour, u.limits.readAt, now);
  const seven = limitDisplay(u.limits.sevenDay, u.limits.readAt, now);
  const p: UsagePeriod = u[period];
  const periodLabel = PERIODS.find((x) => x.key === period)?.label ?? '';

  return (
    <div className="usage">
      <section className="usage-dials" aria-label="Plan limits">
        <LimitDial label="Weekly limit" d={seven} />
        <LimitDial label="5-hour limit" d={five} hero />
        <figure className="usage-dial trip">
          <div className="trip-panel">
            <span className="trip-caption">Today, estimated</span>
            <span className="trip-figure">{usage ? <Odometer text={formatUsd(u.today.costUsd)} /> : <span className="trip-none">no data</span>}</span>
          </div>
          <figcaption>
            What Claude Code use on this machine today would cost at API prices, as estimated by Claude Code. Sessions running here are
            counted as they go; sessions in other windows are added when they end. On a subscription you are not billed this.
          </figcaption>
        </figure>
      </section>

      <FlowCards />

      <section className="usage-breakdown" aria-label="Cost breakdown">
        <div className="usage-tools">
          <div className="segmented" role="group" aria-label="Period">
            {PERIODS.map((x) => (
              <button key={x.key} type="button" className={x.key === period ? 'active' : undefined} aria-pressed={x.key === period} onClick={() => setPeriod(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
          {usage && (
            <span className="usage-total">
              {periodLabel}: <strong>{formatUsd(p.costUsd)}</strong> estimated
            </span>
          )}
        </div>

        {p.byModel.length === 0 ? (
          <p className="empty">
            Nothing recorded for this period. Costs are read from the conversations Claude Code saves on this machine; on the first start
            that reading takes a moment.
          </p>
        ) : (
          <div className="usage-tables">
            <Table caption="By model (cost goes to the model in use when it was reported)" lines={p.byModel} tokens />
            <Table caption="By area" lines={p.byStory} tokens={false} />
          </div>
        )}
      </section>
    </div>
  );
}
