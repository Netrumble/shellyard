import { describe, expect, it } from 'vitest';
import { emptyHistory, recordActivity, sparkPath, SPARK_BUCKET_MS, SPARK_BUCKETS } from '../../src/web/sparkline.js';

const T0 = 1_000 * SPARK_BUCKET_MS;

describe('recordActivity', () => {
  it('adds what each session printed to the current bucket', () => {
    let h = recordActivity(emptyHistory(), { a: 100 }, T0);
    h = recordActivity(h, { a: 50, b: 7 }, T0 + 1000);
    expect(h.series.a).toHaveLength(SPARK_BUCKETS);
    expect(h.series.a!.at(-1)).toBe(150);
    expect(h.series.b!.at(-1)).toBe(7);
  });

  it('moves on one bucket at a time, and fills the buckets skipped with nothing', () => {
    let h = recordActivity(emptyHistory(), { a: 100 }, T0);
    h = recordActivity(h, { a: 10 }, T0 + 3 * SPARK_BUCKET_MS);
    expect(h.series.a!.slice(-4)).toEqual([100, 0, 0, 10]);
  });

  it('drops a session once its whole window is quiet', () => {
    let h = recordActivity(emptyHistory(), { a: 100 }, T0);
    h = recordActivity(h, {}, T0 + SPARK_BUCKETS * SPARK_BUCKET_MS);
    expect(h.series.a).toBeUndefined();
  });

  it('does not change the history it was given', () => {
    const first = recordActivity(emptyHistory(), { a: 1 }, T0);
    const copy = JSON.stringify(first);
    recordActivity(first, { a: 5 }, T0 + SPARK_BUCKET_MS);
    expect(JSON.stringify(first)).toBe(copy);
  });

  it('treats a clock that went back as the current bucket', () => {
    let h = recordActivity(emptyHistory(), { a: 1 }, T0);
    h = recordActivity(h, { a: 2 }, T0 - 5 * SPARK_BUCKET_MS);
    expect(h.series.a!.at(-1)).toBe(3);
  });
});

describe('sparkPath', () => {
  it('draws a flat line at the bottom for a quiet session', () => {
    expect(sparkPath(undefined, 60, 20)).toBe('M0 19 L60 19');
    expect(sparkPath(new Array(SPARK_BUCKETS).fill(0), 60, 20)).toBe('M0 19 L60 19');
  });

  it('spans the width and rises with the output', () => {
    const values = new Array(SPARK_BUCKETS).fill(0);
    values[SPARK_BUCKETS - 1] = 1e9; // far past full scale
    const d = sparkPath(values, 58, 20);
    expect(d.startsWith('M0 19')).toBe(true);
    expect(d.endsWith('L58 1')).toBe(true);
  });
});
