import { useEffect, useState } from 'react';
import { needleAngle, type Zone } from '../gauges.js';
import { useStore } from '../store.js';

const C = 100;
/** Point on a circle of radius r around the dial centre; 0° is straight up, clockwise positive. */
function at(angle: number, r: number): [number, number] {
  const rad = (angle * Math.PI) / 180;
  return [C + r * Math.sin(rad), C - r * Math.cos(rad)];
}

function arc(from: number, to: number, r: number): string {
  const [x1, y1] = at(from, r);
  const [x2, y2] = at(to, r);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const pctAngle = (pct: number): number => needleAngle(pct, 100);

export interface DialProps {
  /** Position on a 0–100 scale. */
  pct: number;
  /** What the dial measures, e.g. "5-hour limit". */
  label: string;
  /** The reading as text, shown in the dial and read out. */
  valueText: string;
  /** A second line under the value. */
  detail?: string;
  zone?: Zone;
  /** A dial with nothing to show: needle at rest, face dimmed. */
  dead?: boolean;
  /** The one dial given the yellow face. */
  hero?: boolean;
  /** Small version for the header: no numerals, no text inside. */
  compact?: boolean;
  size: number;
}

/**
 * A round instrument with a needle. The needle is decoration around a number that is
 * always there as text; the whole dial is announced as "label: value".
 */
export function Dial(props: DialProps): React.JSX.Element {
  const { pct, label, valueText, detail, zone = 'ok', dead = false, hero = false, compact = false, size } = props;
  const { effects } = useStore();
  // Ignition: at key-on the needle runs to full scale and back before showing the reading.
  const [boot, setBoot] = useState<'rest' | 'sweep' | 'live'>(effects === 'full' ? 'rest' : 'live');
  useEffect(() => {
    if (boot === 'live') return;
    const a = setTimeout(() => setBoot('sweep'), 60);
    const b = setTimeout(() => setBoot('live'), 520);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
    // Runs once, when the dial first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = dead ? 0 : pct;
  const angle = boot === 'rest' ? -120 : boot === 'sweep' ? 120 : pctAngle(shown);
  const majors = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const minors = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95];

  return (
    <svg
      className={`dial zone-${zone}${hero ? ' dial-hero' : ''}${dead ? ' dial-dead' : ''}${compact ? ' dial-compact' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label={`${label}: ${valueText}${detail ? `, ${detail}` : ''}`}
    >
      <circle className="dial-bezel" cx={C} cy={C} r={98} />
      <circle className="dial-face" cx={C} cy={C} r={90} />
      <path className="dial-band dial-band-warn" d={arc(pctAngle(70), pctAngle(90), 80)} />
      <path className="dial-band dial-band-danger" d={arc(pctAngle(90), pctAngle(100), 80)} />
      {majors.map((m) => {
        const [x1, y1] = at(pctAngle(m), 86);
        const [x2, y2] = at(pctAngle(m), 72);
        return <line key={m} className="dial-tick" x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
      {!compact &&
        minors.map((m) => {
          const [x1, y1] = at(pctAngle(m), 86);
          const [x2, y2] = at(pctAngle(m), 79);
          return <line key={m} className="dial-tick dial-tick-minor" x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      {!compact &&
        [0, 20, 40, 60, 80, 100].map((m) => {
          const [x, y] = at(pctAngle(m), 58);
          return (
            <text key={m} className="dial-numeral" x={x} y={y}>
              {m}
            </text>
          );
        })}
      {!compact && (
        <>
          <text className="dial-value" x={C} y={150}>
            {valueText}
          </text>
          <text className="dial-label" x={C} y={170}>
            {label}
          </text>
        </>
      )}
      <g className={`dial-needle${effects === 'full' ? ' dial-needle-live' : ''}`} style={{ transform: `rotate(${angle}deg)` }}>
        <polygon points={`${C - 3.2},${C + 14} ${C + 3.2},${C + 14} ${C + 1},${C - 76} ${C - 1},${C - 76}`} />
      </g>
      <circle className="dial-hub" cx={C} cy={C} r={compact ? 12 : 9} />
    </svg>
  );
}
