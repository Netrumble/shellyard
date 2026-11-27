import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module of the desktop app, without types
import { detachedSessionOf, isDetachedWindowUrl, raise } from '../../desktop/windows.js';

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
