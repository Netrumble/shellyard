import { odometerDigits } from '../gauges.js';
import { useStore } from '../store.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * A figure shown like a mechanical counter: each digit is a wheel that rolls to its value.
 * With effects reduced or off it is plain text. Either way it is read out as the plain figure.
 */
export function Odometer({ text }: { text: string }): React.JSX.Element {
  const { effects } = useStore();
  if (effects !== 'full') return <span className="odometer plain">{text}</span>;
  return (
    <span className="odometer" role="img" aria-label={text}>
      {odometerDigits(text).map((ch, i) => {
        const d = DIGITS.indexOf(ch);
        if (d < 0) {
          return (
            <span key={i} className="odo-fixed" aria-hidden="true">
              {ch}
            </span>
          );
        }
        return (
          <span key={i} className="odo-wheel" aria-hidden="true">
            <span className="odo-strip" style={{ transform: `translateY(${-d}em)` }}>
              {DIGITS.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
