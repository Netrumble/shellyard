import { describe, expect, it } from 'vitest';
import { linesFor, SwipeTracker, TAP_SLOP_PX } from '../../src/web/touch-scroll.js';

describe('SwipeTracker', () => {
  it('leaves a small movement to be a tap', () => {
    const s = new SwipeTracker();
    s.start(100);
    expect(s.move(100 + TAP_SLOP_PX - 1)).toBeNull();
    expect(s.active).toBe(false);
  });

  it('scrolls up into the history when the finger moves down', () => {
    const s = new SwipeTracker();
    s.start(100);
    expect(s.move(130)).toBe(-30);
    expect(s.move(150)).toBe(-20);
    expect(s.active).toBe(true);
  });

  it('scrolls down when the finger moves up, and keeps scrolling once started', () => {
    const s = new SwipeTracker();
    s.start(200);
    expect(s.move(180)).toBe(20);
    expect(s.move(179)).toBe(1);
  });

  it('does nothing without a start, or after the end', () => {
    const s = new SwipeTracker();
    expect(s.move(50)).toBeNull();
    s.start(0);
    s.move(40);
    s.end();
    expect(s.move(80)).toBeNull();
    expect(s.active).toBe(false);
  });
});

describe('linesFor', () => {
  it('scrolls whole lines and keeps the rest for the next move', () => {
    expect(linesFor(45, 20)).toEqual({ lines: 2, rest: 5 });
    expect(linesFor(-45, 20)).toEqual({ lines: -2, rest: -5 });
    expect(linesFor(19, 20)).toEqual({ lines: 0, rest: 19 });
  });

  it('does nothing while the terminal has no height', () => {
    expect(linesFor(100, 0)).toEqual({ lines: 0, rest: 0 });
  });
});
