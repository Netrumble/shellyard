import { describe, expect, it } from 'vitest';
import { launcherIndex } from '../../src/web/shortcuts.js';

const key = (code: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({ code, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

describe('launcherIndex', () => {
  it('maps Alt 1 to 9 to the launchers in order', () => {
    expect(launcherIndex(key('Digit1'), 3, false)).toBe(0);
    expect(launcherIndex(key('Digit3'), 3, false)).toBe(2);
    expect(launcherIndex(key('Numpad2'), 3, false)).toBe(1);
  });

  it('ignores a number past the last launcher, and 0', () => {
    expect(launcherIndex(key('Digit4'), 3, false)).toBeNull();
    expect(launcherIndex(key('Digit0'), 9, false)).toBeNull();
  });

  it('wants Alt alone', () => {
    expect(launcherIndex(key('Digit1', { altKey: false }), 3, false)).toBeNull();
    expect(launcherIndex(key('Digit1', { ctrlKey: true }), 3, false)).toBeNull(); // AltGr on Windows
    expect(launcherIndex(key('Digit1', { metaKey: true }), 3, false)).toBeNull();
    expect(launcherIndex(key('Digit1', { shiftKey: true }), 3, false)).toBeNull();
    expect(launcherIndex(key('KeyA'), 3, false)).toBeNull();
  });

  it('leaves the key to a terminal or a text field that has the focus', () => {
    expect(launcherIndex(key('Digit1'), 3, true)).toBeNull();
  });
});
