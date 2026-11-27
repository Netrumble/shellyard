import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module of the desktop app, without types
import { detachedSessionOf, isDetachedWindowUrl, placeOnScreen, raise } from '../../desktop/windows.js';

const ORIGIN = 'http://0123456789abcdef0123456789abcdef.localhost:7717';
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('isDetachedWindowUrl', () => {
  it("allows a session's own window on the server of this start", () => {
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=${ID}`, ORIGIN)).toBe(true);
  });

  it('refuses other origins, other paths and other addresses', () => {
    expect(isDetachedWindowUrl(`http://evil.example/?detached=${ID}`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`http://127.0.0.1:7717/?detached=${ID}`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/api/sessions?detached=${ID}`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=nope`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=${ID}&x=1`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl('not a url', ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=${ID}`, null)).toBe(false);
  });
});

describe('detachedSessionOf', () => {
  it("names the session of a session's own window, also once the token left its address", () => {
    expect(detachedSessionOf(`${ORIGIN}/?detached=${ID}`, ORIGIN)).toBe(ID);
    expect(detachedSessionOf(`${ORIGIN}/?detached=${ID}#token=x`, ORIGIN)).toBe(ID);
  });

  it('gives null for the main window and any other address', () => {
    expect(detachedSessionOf(`${ORIGIN}/`, ORIGIN)).toBeNull();
    expect(detachedSessionOf(`http://evil.example/?detached=${ID}`, ORIGIN)).toBeNull();
    expect(detachedSessionOf('', ORIGIN)).toBeNull();
  });
});

describe('raise', () => {
  const fakeWindow = (minimized: boolean) => {
    const calls: string[] = [];
    const w = {
      isMinimized: () => minimized,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      moveTop: () => calls.push('moveTop'),
      focus: vi.fn(() => calls.push('focus')),
    };
    return { w, calls };
  };

  it('restores a minimised window before bringing it forward', () => {
    const { w, calls } = fakeWindow(true);
    raise(w);
    expect(calls).toEqual(['restore', 'show', 'moveTop', 'focus']);
  });

  it('brings a window that is only behind others forward', () => {
    const { w, calls } = fakeWindow(false);
    raise(w);
    expect(calls).toEqual(['show', 'moveTop', 'focus']);
  });
});

describe('placeOnScreen', () => {
  const main = { x: 0, y: 0, width: 1920, height: 1040 };
  const left = { x: -1920, y: 0, width: 1920, height: 1040 };

  it('leaves a window whose title bar is on a screen where it is, on any monitor', () => {
    const b = { x: 200, y: 100, width: 900, height: 600 };
    expect(placeOnScreen(b, [main, left], main)).toBe(b);
    const other = { x: -1500, y: 50, width: 900, height: 600 };
    expect(placeOnScreen(other, [main, left], main)).toBe(other);
  });

  it('centres on the main window screen a window off every screen, or where a minimised one was', () => {
    expect(placeOnScreen({ x: -1500, y: 50, width: 900, height: 600 }, [main], main)).toEqual({ x: 510, y: 220, width: 900, height: 600 });
    expect(placeOnScreen({ x: -32000, y: -32000, width: 900, height: 600 }, [main], main)).toEqual({ x: 510, y: 220, width: 900, height: 600 });
  });

  it('brings back a window whose title bar is above the screen, and shrinks one larger than it', () => {
    expect(placeOnScreen({ x: 200, y: -700, width: 900, height: 800 }, [main], main)).toEqual({ x: 510, y: 120, width: 900, height: 800 });
    expect(placeOnScreen({ x: 5000, y: 0, width: 3000, height: 2000 }, [main], main)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
});
