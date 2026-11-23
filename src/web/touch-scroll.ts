// xterm 6 carries touch-gesture code but never switches it on, so on a phone a swipe over a
// terminal does nothing. Here a vertical swipe scrolls the history line by line, or, when a
// full-screen program has the screen, reaches it as wheel events, as a mouse would on a desktop.

/** Below this many pixels a touch is a tap, which must still focus the terminal and open the keyboard. */
export const TAP_SLOP_PX = 8;

/** Follows one finger and says how far to scroll at each move; null while it is still a tap. */
export class SwipeTracker {
  private startY: number | null = null;
  private lastY = 0;
  private scrolling = false;

  start(y: number): void {
    this.startY = y;
    this.lastY = y;
    this.scrolling = false;
  }

  /** Pixels to scroll down (positive) or up (negative) for this move, or null if not scrolling yet. */
  move(y: number): number | null {
    if (this.startY === null) return null;
    if (!this.scrolling && Math.abs(y - this.startY) < TAP_SLOP_PX) return null;
    this.scrolling = true;
    // The finger moving up shows what is below, as on any page.
    const delta = this.lastY - y;
    this.lastY = y;
    return delta;
  }

  get active(): boolean {
    return this.scrolling;
  }

  end(): void {
    this.startY = null;
    this.scrolling = false;
  }
}

/** What of the terminal a swipe needs: its rows, and whether a program has taken the scrolling. */
export interface ScrollTarget {
  readonly rows: number;
  readonly buffer: { readonly active: { readonly type: 'normal' | 'alternate'; readonly viewportY: number; readonly baseY: number } };
  readonly modes: { readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' };
  scrollLines(amount: number): void;
}

/**
 * Who a swipe belongs to, decided once when it starts to move: the terminal, or the page around
 * it. The page gets it when the history is already at its end in that direction (so stacked
 * tiles can still be scrolled past), and when a full-screen program has the screen outside the
 * single view, since such a program would otherwise keep the page from scrolling at all.
 */
export function swipeOwner(term: ScrollTarget, delta: number, single: boolean): 'terminal' | 'page' {
  const { type, viewportY, baseY } = term.buffer.active;
  if (type === 'alternate' || term.modes.mouseTrackingMode !== 'none') return single ? 'terminal' : 'page';
  if (delta < 0 && viewportY <= 0) return 'page';
  if (delta > 0 && viewportY >= baseY) return 'page';
  return 'terminal';
}

/** Whole lines to scroll for the pixels gathered so far, and the pixels left over. */
export function linesFor(pixels: number, lineHeight: number): { lines: number; rest: number } {
  if (lineHeight <= 0) return { lines: 0, rest: 0 };
  const lines = Math.trunc(pixels / lineHeight);
  return { lines, rest: pixels - lines * lineHeight };
}

/** Turns one-finger vertical swipes over `host` into scrolling of `term`; returns the undo. */
export function attachTouchScroll(host: HTMLElement, term: ScrollTarget): () => void {
  const swipe = new SwipeTracker();
  let finger: number | null = null;
  let pending = 0;
  let owner: 'terminal' | 'page' | null = null;

  const onStart = (e: TouchEvent): void => {
    pending = 0;
    owner = null;
    if (e.touches.length !== 1) {
      finger = null;
      swipe.end();
      return;
    }
    const t = e.touches[0]!;
    finger = t.identifier;
    swipe.start(t.clientY);
  };
  const onMove = (e: TouchEvent): void => {
    if (finger === null) return;
    const t = Array.from(e.changedTouches).find((c) => c.identifier === finger);
    if (!t) return;
    const delta = swipe.move(t.clientY);
    if (delta === null) return;
    owner ??= swipeOwner(term, delta, host.closest('.tile.single') !== null);
    if (owner === 'page') return;
    // The page must not scroll or bounce while the terminal does.
    e.preventDefault();
    const screen = host.querySelector<HTMLElement>('.xterm-screen');
    const { lines, rest } = linesFor(pending + delta, (screen?.clientHeight ?? 0) / Math.max(1, term.rows));
    pending = rest;
    if (lines === 0) return;
    if (term.buffer.active.type === 'alternate' || term.modes.mouseTrackingMode !== 'none') {
      // A full-screen program scrolls itself: it gets the wheel, as from a mouse on a desktop.
      (screen ?? host).dispatchEvent(new WheelEvent('wheel', { deltaY: lines, deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: t.clientX, clientY: t.clientY, bubbles: true, cancelable: true }));
    } else {
      term.scrollLines(lines);
    }
  };
  const onEnd = (): void => {
    finger = null;
    pending = 0;
    owner = null;
    swipe.end();
  };

  host.addEventListener('touchstart', onStart, { passive: true });
  host.addEventListener('touchmove', onMove, { passive: false });
  host.addEventListener('touchend', onEnd);
  host.addEventListener('touchcancel', onEnd);
  return () => {
    host.removeEventListener('touchstart', onStart);
    host.removeEventListener('touchmove', onMove);
    host.removeEventListener('touchend', onEnd);
    host.removeEventListener('touchcancel', onEnd);
  };
}
