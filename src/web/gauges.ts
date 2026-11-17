import type { LimitReading } from '../shared/types.js';

// The arithmetic behind the dials. Kept free of the DOM so that it can be tested.

/** A dial sweeps 240 degrees: straight up is the middle of the scale. */
const SWEEP_HALF = 120;

/** Needle rotation in degrees: -120 at zero, +120 at full scale. */
export function needleAngle(value: number, max: number): number {
  if (!(max > 0) || Number.isNaN(value)) return -SWEEP_HALF;
  const fraction = Math.min(1, Math.max(0, value / max));
  return -SWEEP_HALF + fraction * 2 * SWEEP_HALF;
}

export type Zone = 'ok' | 'warn' | 'danger';

export function zoneOf(pct: number): Zone {
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warn';
  return 'ok';
}

export type ShiftLight = 'off' | 'green' | 'amber' | 'red';

/** The row of lights over the cluster: lit in proportion, green first, red at the end. */
export function shiftLights(pct: number, count = 10): ShiftLight[] {
  const safe = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const lit = Math.floor((safe / 100) * count);
  return Array.from({ length: count }, (_, i): ShiftLight => {
    if (i >= lit) return 'off';
    const position = i / count;
    if (position < 0.5) return 'green';
    if (position < 0.8) return 'amber';
    return 'red';
  });
}

/** Two units at most: "45s", "5m", "1h 12m", "3d 4h". */
export function durationLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (!(seconds > 0)) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface LimitDisplay {
  /** "expired": the limit has reset since the reading, so the figure no longer holds. */
  state: 'no-data' | 'expired' | 'ok';
  pct: number;
  resetsIn: string;
  age: string;
}

/** What a limit dial should show, given the last reading and how old it is. */
export function limitDisplay(reading: LimitReading | null, readAt: number | null, now: number): LimitDisplay {
  if (!reading) return { state: 'no-data', pct: 0, resetsIn: '', age: '' };
  const elapsed = readAt === null ? '' : durationLabel(now - readAt);
  const age = elapsed === '' ? '' : elapsed === 'now' ? 'just now' : `${elapsed} ago`;
  if (reading.resetsAt <= now) return { state: 'expired', pct: 0, resetsIn: '', age };
  return {
    state: 'ok',
    pct: Math.round(Math.min(100, Math.max(0, reading.usedPercentage))),
    resetsIn: durationLabel(reading.resetsAt - now),
    age,
  };
}

const REV_FULL_SCALE = 20_000;

/**
 * Where a rev counter's needle sits (0 to 1) for an output rate in bytes per second.
 * Logarithmic: a prompt echoing a few characters must be visible, and a build scrolling
 * past must not pin the needle for everything above it.
 */
export function revLevel(bytesPerSecond: number): number {
  if (!(bytesPerSecond > 0)) return 0;
  return Math.min(1, Math.log10(1 + bytesPerSecond) / Math.log10(1 + REV_FULL_SCALE));
}

export function formatUsd(v: number): string {
  const safe = Number.isFinite(v) && v > 0 ? v : 0;
  if (safe >= 1000) return `$${Math.round(safe).toLocaleString('en-US')}`;
  return `$${safe.toFixed(2)}`;
}

export function formatTokens(v: number): string {
  const safe = Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  if (safe < 1000) return String(safe);
  if (safe < 999_950) return `${(safe / 1000).toFixed(1)}k`;
  return `${(safe / 1_000_000).toFixed(1)}M`;
}

/** One entry per character, each of which becomes a rolling column. */
export function odometerDigits(text: string): string[] {
  return [...text];
}
