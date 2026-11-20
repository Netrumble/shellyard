import { useEffect, useState } from 'react';
import type { SessionInfo } from '../../shared/types.js';
import { lampState, type EffectsLevel } from '../effects.js';
import { limitDisplay, revLevel, shiftLights, zoneOf } from '../gauges.js';
import { statusLabel } from '../selectors.js';
import { setEffects, setSound, setTheme, setView, useStore } from '../store.js';
import type { ThemeChoice } from '../theme.js';
import { Dial } from './Dial.js';
import { SoundsDialog } from './SoundsDialog.js';

/** The current time, refreshed often enough for countdowns shown to the minute. */
export function useNow(everyMs = 10_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** A small rev counter: how much a session's terminal is printing right now. */
export function Tachometer({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { activity, effects } = useStore();
  if (effects === 'off') return null;
  const level = revLevel(activity[sessionId] ?? 0);
  const angle = -90 + level * 180;
  return (
    <svg className="tacho" width="26" height="16" viewBox="0 0 40 24" aria-hidden="true">
      <path className="tacho-arc" d="M 4 21 A 16 16 0 0 1 36 21" />
      <path className="tacho-red" d="M 31.3 9.7 A 16 16 0 0 1 36 21" />
      <line className={effects === 'full' ? 'tacho-needle tacho-needle-live' : 'tacho-needle'} x1="20" y1="21" x2="20" y2="7" style={{ transform: `rotate(${angle}deg)` }} />
    </svg>
  );
}

/** The row of lights that fills as the 5-hour limit is used up. */
function ShiftLights({ pct, known }: { pct: number; known: boolean }): React.JSX.Element {
  const { effects } = useStore();
  const lights = shiftLights(known ? pct : 0);
  const urgent = known && pct >= 90 && effects === 'full';
  return (
    <div className={urgent ? 'shift-lights urgent' : 'shift-lights'} aria-hidden="true">
      {lights.map((l, i) => (
        <span key={i} className={`shift-light shift-${l}`} />
      ))}
    </div>
  );
}

/** One lamp per session, as on a dashboard: a glance tells which ones want something. */
function Lamps({ sessions }: { sessions: SessionInfo[] }): React.JSX.Element | null {
  if (sessions.length === 0) return null;
  return (
    <ul className="lamps" aria-label="Sessions">
      {sessions.map((s) => {
        const text = `${s.name}: ${statusLabel(s)}`;
        return (
          <li key={s.id}>
            <button type="button" className={`lamp lamp-${lampState(s)}`} title={text} aria-label={text} onClick={() => setView({ kind: 'single', id: s.id })} />
          </li>
        );
      })}
    </ul>
  );
}

function EffectsMenu(): React.JSX.Element {
  const { effects, sound, themeChoice } = useStore();
  const [sounds, setSounds] = useState(false);
  return (
    <div className="effects-menu">
      <label>
        <span>Theme</span>
        <select value={themeChoice} onChange={(e) => setTheme(e.target.value as ThemeChoice)}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="talentia">Talentia</option>
        </select>
      </label>
      <label>
        <span>Effects</span>
        <select value={effects} onChange={(e) => setEffects(e.target.value as EffectsLevel)}>
          <option value="full">Full</option>
          <option value="reduced">Reduced</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label className="check" title="A soft chime when a session starts waiting for you">
        <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
        <span>Sound</span>
      </label>
      <button type="button" className="link" onClick={() => setSounds(true)}>
        Sounds…
      </button>
      {sounds && <SoundsDialog onClose={() => setSounds(false)} />}
    </div>
  );
}

/** The instruments in the header, present on every view. */
export function Cluster(): React.JSX.Element {
  const { usage, sessions, effects } = useStore();
  const now = useNow();
  const limits = usage?.limits ?? { fiveHour: null, sevenDay: null, readAt: null };
  const five = limitDisplay(limits.fiveHour, limits.readAt, now);
  const seven = limitDisplay(limits.sevenDay, limits.readAt, now);
  const text = (d: typeof five): string => (d.state === 'ok' ? `${d.pct}%` : 'no data');

  return (
    <div className="cluster">
      <button
        type="button"
        className={five.state === 'ok' || seven.state === 'ok' ? 'cluster-limits' : 'cluster-limits stale'}
        title={five.age ? `Plan limits, read ${five.age}. Open usage` : 'Plan limits: no reading yet. Open usage'}
        onClick={() => setView({ kind: 'usage' })}
      >
        {effects !== 'off' && <ShiftLights pct={five.pct} known={five.state === 'ok'} />}
        {/* As on the usage page: weekly first, then the 5-hour limit on the yellow face. */}
        <span className="cluster-dials">
          {effects !== 'off' && <Dial compact size={34} pct={seven.pct} dead={seven.state !== 'ok'} zone={zoneOf(seven.pct)} label="Weekly limit" valueText={text(seven)} />}
          <span className={`cluster-reading zone-text-${seven.state === 'ok' ? zoneOf(seven.pct) : 'none'}`}>
            <span className="cluster-caption">Weekly</span>
            <span className="cluster-figure">{text(seven)}</span>
          </span>
          {effects !== 'off' && <Dial compact hero size={34} pct={five.pct} dead={five.state !== 'ok'} zone={zoneOf(five.pct)} label="5-hour limit" valueText={text(five)} />}
          <span className={`cluster-reading zone-text-${five.state === 'ok' ? zoneOf(five.pct) : 'none'}`}>
            <span className="cluster-caption">5-hour</span>
            <span className="cluster-figure">{text(five)}</span>
          </span>
        </span>
        {five.age && <span className="cluster-age">read {five.age}</span>}
      </button>
      <Lamps sessions={sessions} />
      <EffectsMenu />
    </div>
  );
}
