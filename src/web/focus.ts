import type { SessionInfo } from '../shared/types.js';

// Focus: for a while, only what blocks a session interrupts (permissions, questions). Sessions
// that merely finish are kept for a digest at the end. A choice of this browser, like the sound.

export const FOCUS_MINUTES = 45;
const FOCUS_KEY = 'shellyard-focus';

export interface Focus {
  startedAt: number;
  until: number;
}

export function startFocus(now: number, minutes = FOCUS_MINUTES): Focus {
  return { startedAt: now, until: now + minutes * 60_000 };
}

export function focusOn(f: Focus | null, now: number): boolean {
  return f !== null && now < f.until;
}

/** Whole minutes left, at least 1 while it lasts. */
export function minutesLeft(f: Focus, now: number): number {
  return Math.max(1, Math.ceil((f.until - now) / 60_000));
}

/** Of the sessions that just started waiting: which may interrupt now, and which wait for the digest. */
export function splitForFocus(waiting: SessionInfo[], on: boolean): { interrupt: SessionInfo[]; digest: SessionInfo[] } {
  if (!on) return { interrupt: waiting, digest: [] };
  const finished = (s: SessionInfo): boolean => s.reason === 'finished';
  return { interrupt: waiting.filter((s) => !finished(s)), digest: waiting.filter(finished) };
}

/** Adds sessions to the digest, each once. */
export function addToDigest(digest: string[], ids: string[]): string[] {
  const next = [...digest];
  for (const id of ids) if (!next.includes(id)) next.push(id);
  return next;
}

/** "While you focused, 3 sessions finished: A, B and C." */
export function digestText(names: string[]): string {
  if (names.length === 0) return 'Nothing finished while you focused.';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `While you focused, ${names.length} session${names.length === 1 ? '' : 's'} finished: ${list}.`;
}

export function loadFocus(now: number): Focus | null {
  try {
    const raw = JSON.parse(localStorage.getItem(FOCUS_KEY) ?? 'null') as Partial<Focus> | null;
    if (!raw || typeof raw.until !== 'number' || typeof raw.startedAt !== 'number') return null;
    return now < raw.until ? { startedAt: raw.startedAt, until: raw.until } : null;
  } catch {
    return null;
  }
}

export function saveFocus(f: Focus | null): void {
  try {
    if (f) localStorage.setItem(FOCUS_KEY, JSON.stringify(f));
    else localStorage.removeItem(FOCUS_KEY);
  } catch {
    // Not remembered after a reload; it still applies now.
  }
}
