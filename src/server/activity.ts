const WINDOW_MS = 1000;

interface Sample {
  at: number;
  bytes: number;
}

/** How much each terminal has printed in the last second. Drives the rev counters. */
export class ActivityMeter {
  private readonly samples = new Map<string, Sample[]>();

  constructor(private readonly now: () => number) {}

  /** Drops the samples that have left the window, in one cut. */
  private trim(list: Sample[], cutoff: number): void {
    let stale = 0;
    while (stale < list.length && list[stale]!.at <= cutoff) stale++;
    if (stale > 0) list.splice(0, stale);
  }

  add(id: string, bytes: number): void {
    const now = this.now();
    let list = this.samples.get(id);
    if (!list) this.samples.set(id, (list = []));
    // Trimmed on every write, not only when someone reads: with no browser connected nobody
    // reads for hours, and the list must not grow in the meantime.
    this.trim(list, now - WINDOW_MS);
    list.push({ at: now, bytes });
  }

  /** Bytes in the last second per session. Sessions that printed nothing are left out. */
  rates(): Record<string, number> {
    const cutoff = this.now() - WINDOW_MS;
    const out: Record<string, number> = {};
    for (const [id, list] of this.samples) {
      this.trim(list, cutoff);
      if (list.length === 0) {
        this.samples.delete(id);
        continue;
      }
      out[id] = list.reduce((sum, s) => sum + s.bytes, 0);
    }
    return out;
  }

  /** How many samples are held in all; for checking that it stays bounded. */
  sampleCount(): number {
    let n = 0;
    for (const list of this.samples.values()) n += list.length;
    return n;
  }

  forget(id: string): void {
    this.samples.delete(id);
  }
}
