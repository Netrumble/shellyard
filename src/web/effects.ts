import type { SessionInfo } from '../shared/types.js';

/**
 * How much the interface moves. "reduced" keeps colours and values but drops sweeps, pulses
 * and rolling digits; "off" also drops the decorative instruments.
 */
export type EffectsLevel = 'full' | 'reduced' | 'off';

const LEVELS: readonly string[] = ['full', 'reduced', 'off'];
const EFFECTS_KEY = 'cvm-effects';
const SOUND_KEY = 'cvm-sound';

/** The saved choice if there is one; otherwise the system's preference about motion. */
export function resolveEffects(saved: string | null, prefersReducedMotion: boolean): EffectsLevel {
  if (saved !== null && LEVELS.includes(saved)) return saved as EffectsLevel;
  return prefersReducedMotion ? 'reduced' : 'full';
}

export type LampState = 'off' | 'working' | 'blocked' | 'finished' | 'exited';

/** The warning lamp of a session in the header cluster. */
export function lampState(s: SessionInfo): LampState {
  if (s.status === 'attention') return s.reason === 'finished' ? 'finished' : 'blocked';
  if (s.status === 'working' || s.status === 'running') return 'working';
  if (s.status === 'exited') return 'exited';
  return 'off';
}

// These preferences belong to this browser only, so they live in its storage.

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered next time; it still applies now.
  }
}

export function loadEffects(): EffectsLevel {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return resolveEffects(read(EFFECTS_KEY), reduced);
}

export function saveEffects(level: EffectsLevel): void {
  write(EFFECTS_KEY, level);
}

/** Sound is on until the user switches it off. */
export function resolveSound(saved: string | null): boolean {
  return saved !== 'off';
}

export function loadSound(): boolean {
  return resolveSound(read(SOUND_KEY));
}

export function saveSound(on: boolean): void {
  write(SOUND_KEY, on ? 'on' : 'off');
}
