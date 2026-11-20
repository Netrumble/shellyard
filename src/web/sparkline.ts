import { revLevel } from './gauges.js';

// What each terminal printed over the last few minutes, for the small line on its row. Kept in
// the page only: built from the activity the server sends every second, so it starts empty
// when the page is opened.

export const SPARK_BUCKET_MS = 10_000;
/** Thirty buckets of ten seconds: the last five minutes. */
export const SPARK_BUCKETS = 30;

export interface SparkHistory {
  /** The bucket the last value went into (time divided by the bucket length); -1 before any. */
  bucket: number;
  /** Per session, bytes printed in each bucket, oldest first, always SPARK_BUCKETS long. */
  series: Record<string, number[]>;
}

export function emptyHistory(): SparkHistory {
  return { bucket: -1, series: {} };
}

/** Adds one second of activity (bytes per session) at time `now`; returns a new history. */
export function recordActivity(h: SparkHistory, rates: Record<string, number>, now: number): SparkHistory {
  const bucket = Math.max(Math.floor(now / SPARK_BUCKET_MS), h.bucket);
  const shift = h.bucket < 0 ? 0 : Math.min(bucket - h.bucket, SPARK_BUCKETS);
  const series: Record<string, number[]> = {};
  const ids = new Set([...Object.keys(h.series), ...Object.keys(rates)]);
  for (const id of ids) {
    const old = h.series[id] ?? new Array<number>(SPARK_BUCKETS).fill(0);
    const next = shift > 0 ? [...old.slice(shift), ...new Array<number>(shift).fill(0)] : [...old];
    const rate = rates[id];
    if (typeof rate === 'number' && rate > 0) next[SPARK_BUCKETS - 1]! += rate;
    if (next.some((v) => v > 0)) series[id] = next;
  }
  return { bucket, series };
}

/**
 * An SVG path for a row of values, oldest on the left. The height follows the same curve as
 * the rev counters, so that a trickle shows and a flood does not flatten everything else.
 */
export function sparkPath(values: number[] | undefined, width: number, height: number): string {
  const bottom = height - 1;
  if (!values || values.length < 2 || !values.some((v) => v > 0)) return `M0 ${bottom} L${width} ${bottom}`;
  const perSecond = SPARK_BUCKET_MS / 1000;
  const step = width / (values.length - 1);
  return values
    .map((v, i) => {
      const x = Math.round(i * step * 10) / 10;
      const y = Math.round((bottom - revLevel(v / perSecond) * (height - 2)) * 10) / 10;
      return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}
