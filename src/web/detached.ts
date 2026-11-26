import { useSyncExternalStore } from 'react';

// A session can be shown in a window of its own (to put it on another monitor): the same page,
// opened on ?detached=<session id>, showing only that terminal. The pages of one origin tell each
// other which sessions are detached over a BroadcastChannel, so that the main page shows a
// placeholder instead of a second copy of the terminal (two pages drawing one session would
// fight over its size). The session itself is never touched: detaching and bringing back only
// open and close a view of it.

const CHANNEL = 'shellyard-detached';
const BOUNDS_KEY = 'shellyard-detached-bounds';
/** How many sessions' window positions are kept. */
const BOUNDS_KEPT = 50;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DetachedMessage =
  | { t: 'open'; id: string }
  | { t: 'closed'; id: string }
  | { t: 'who' }
  | { t: 'close'; id: string }
  | { t: 'focus'; id: string };

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  screenX: number;
  screenY: number;
}

/** The session this page shows alone, from its address; null for the main page. */
export function detachedIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get('detached');
  return id && SESSION_ID.test(id) ? id : null;
}

/** The address of a session's own window, on the page's own origin. */
export function detachedUrl(id: string): string {
  return `/?detached=${encodeURIComponent(id)}`;
}

/** The name of a session's window: opening it again reaches the same window. */
export function windowName(id: string): string {
  return `shellyard-${id}`;
}

/** A message of the channel, or null when it is not one (anything can be posted on it). */
export function parseMessage(data: unknown): DetachedMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const m = data as { t?: unknown; id?: unknown };
  if (m.t === 'who') return { t: 'who' };
  if ((m.t === 'open' || m.t === 'closed' || m.t === 'close' || m.t === 'focus') && typeof m.id === 'string' && SESSION_ID.test(m.id)) return { t: m.t, id: m.id };
  return null;
}

const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;

function validBounds(b: unknown): b is Bounds {
  if (typeof b !== 'object' || b === null) return false;
  const v = b as Record<string, unknown>;
  return ['left', 'top', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

/**
 * Where a session's window opens: where the drag dropped it (its top-left corner a little
 * above and left of the pointer, so the header comes under it), else where it was last, else
 * a size that fits a terminal. Monitors left of or above the main one have negative positions.
 */
export function boundsFor(saved: Bounds | null, at: ScreenPoint | null): Bounds {
  const width = Math.max(MIN_WIDTH, Math.round(saved?.width ?? 900));
  const height = Math.max(MIN_HEIGHT, Math.round(saved?.height ?? 600));
  if (at) return { left: Math.round(at.screenX - 40), top: Math.round(at.screenY - 16), width, height };
  if (saved) return { left: Math.round(saved.left), top: Math.round(saved.top), width, height };
  return { left: NaN, top: NaN, width, height };
}

/** The features string of window.open for those bounds (a position only when there is one). */
export function windowFeatures(b: Bounds): string {
  const parts = ['popup', `width=${b.width}`, `height=${b.height}`];
  if (Number.isFinite(b.left) && Number.isFinite(b.top)) parts.push(`left=${b.left}`, `top=${b.top}`);
  return parts.join(',');
}

/**
 * True when a drag ended outside the window: the drop then means "put it there". The
 * coordinates are the pointer's on the screen; the rectangle is the window's, frame included.
 */
export function droppedOutside(at: ScreenPoint, win: { screenX: number; screenY: number; outerWidth: number; outerHeight: number }): boolean {
  // A drag ended by the system without a position reports 0,0: not a place to open a window.
  if (at.screenX === 0 && at.screenY === 0) return false;
  return at.screenX < win.screenX || at.screenY < win.screenY || at.screenX >= win.screenX + win.outerWidth || at.screenY >= win.screenY + win.outerHeight;
}

/** The saved positions with `id`'s set to `b`, the most recent last, at most BOUNDS_KEPT of them. */
export function withBounds(all: Record<string, Bounds>, id: string, b: Bounds): Record<string, Bounds> {
  const rest = Object.entries(all).filter(([k]) => k !== id);
  return Object.fromEntries([...rest.slice(-(BOUNDS_KEPT - 1)), [id, b]]);
}

function readAllBounds(): Record<string, Bounds> {
  try {
    const raw = JSON.parse(localStorage.getItem(BOUNDS_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Bounds] => validBounds(e[1])));
  } catch {
    return {};
  }
}

export function savedBounds(id: string): Bounds | null {
  return readAllBounds()[id] ?? null;
}

export function saveBounds(id: string, b: Bounds): void {
  try {
    localStorage.setItem(BOUNDS_KEY, JSON.stringify(withBounds(readAllBounds(), id, b)));
  } catch {
    // Storage can be unavailable: the window then opens at the default size next time.
  }
}

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

// ---- The main page: which sessions are detached, and the windows it opened. ----

let detached: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const opened = new Map<string, Window>();
let channel: BroadcastChannel | null = null;

function setDetached(next: ReadonlySet<string>): void {
  detached = next;
  for (const l of listeners) l();
}

function mark(id: string, on: boolean): void {
  if (detached.has(id) === on) return;
  const next = new Set(detached);
  if (on) next.add(id);
  else next.delete(id);
  setDetached(next);
}

/** Starts listening, in the main page, for the windows of detached sessions. */
export function startDetachedRegistry(): void {
  if (channel) return;
  channel = openChannel();
  if (!channel) return;
  channel.onmessage = (e: MessageEvent) => {
    const m = parseMessage(e.data);
    if (m?.t === 'open') mark(m.id, true);
    else if (m?.t === 'closed') {
      opened.delete(m.id);
      mark(m.id, false);
    }
  };
  // Windows opened before this page was (re)loaded say they are there.
  channel.postMessage({ t: 'who' } satisfies DetachedMessage);
}

/** The ids of the sessions shown in a window of their own. */
export function useDetached(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => detached,
  );
}

/**
 * Opens a session in a window of its own, or brings its window forward if it has one. `at` is
 * where a drag dropped it. False when the browser refused the window (a popup blocker).
 */
export function detach(id: string, at: ScreenPoint | null = null): boolean {
  const known = opened.get(id);
  if (known && !known.closed) {
    known.focus();
    return true;
  }
  if (detached.has(id)) {
    channel?.postMessage({ t: 'focus', id } satisfies DetachedMessage);
    return true;
  }
  const win = window.open(detachedUrl(id), windowName(id), windowFeatures(boundsFor(savedBounds(id), at)));
  if (!win) return false;
  opened.set(id, win);
  // Shown at once: the window says it is open only once its page has loaded.
  mark(id, true);
  // A window that never loads (closed at once, or blocked after the fact) gives the session back.
  const watch = window.setInterval(() => {
    if (!win.closed) return;
    window.clearInterval(watch);
    if (opened.get(id) === win) opened.delete(id);
    mark(id, false);
  }, 1000);
  return true;
}

/** Brings a detached session back into the page: its window is closed. */
export function reattach(id: string): void {
  const known = opened.get(id);
  if (known && !known.closed) known.close();
  channel?.postMessage({ t: 'close', id } satisfies DetachedMessage);
  opened.delete(id);
  mark(id, false);
}

/** True when the session is shown in a window of its own. */
export function isDetached(id: string): boolean {
  return detached.has(id);
}

/** Brings a detached session's window forward. */
export function showDetached(id: string): void {
  detach(id);
}

// ---- The detached window itself. ----

/**
 * Runs in the window of a detached session: says it is open (also to a main page loaded
 * later), closes or comes forward when asked, and on leaving remembers where it was and says
 * it is closed.
 */
export function announceDetached(id: string): () => void {
  const ch = openChannel();
  const say = (m: DetachedMessage): void => ch?.postMessage(m);
  if (ch) {
    ch.onmessage = (e: MessageEvent) => {
      const m = parseMessage(e.data);
      if (m?.t === 'who') say({ t: 'open', id });
      else if (m?.t === 'close' && m.id === id) window.close();
      else if (m?.t === 'focus' && m.id === id) window.focus();
    };
  }
  say({ t: 'open', id });
  const leave = (): void => {
    saveBounds(id, { left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight });
    say({ t: 'closed', id });
  };
  window.addEventListener('pagehide', leave);
  return () => {
    window.removeEventListener('pagehide', leave);
    ch?.close();
  };
}
