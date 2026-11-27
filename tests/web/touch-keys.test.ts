import { describe, expect, it } from 'vitest';
import { TOUCH_KEYS, touchKeySequence } from '../../src/web/touch-keys.js';

describe('touchKeySequence', () => {
  it('sends the arrows as a keyboard does, in normal cursor mode', () => {
    expect(touchKeySequence('up', false)).toBe('\x1b[A');
    expect(touchKeySequence('down', false)).toBe('\x1b[B');
    expect(touchKeySequence('right', false)).toBe('\x1b[C');
    expect(touchKeySequence('left', false)).toBe('\x1b[D');
  });

  it('sends the arrows in application cursor mode when the program asked for it', () => {
    expect(touchKeySequence('up', true)).toBe('\x1bOA');
    expect(touchKeySequence('down', true)).toBe('\x1bOB');
  });

  it('sends Escape, Tab, Enter and Ctrl+C whatever the mode', () => {
    for (const mode of [false, true]) {
      expect(touchKeySequence('escape', mode)).toBe('\x1b');
      expect(touchKeySequence('tab', mode)).toBe('\t');
      expect(touchKeySequence('enter', mode)).toBe('\r');
      expect(touchKeySequence('ctrl-c', mode)).toBe('\x03');
    }
  });
});

describe('TOUCH_KEYS', () => {
  it('offers what a menu needs from a phone: the arrows, Enter and Escape', () => {
    const names = TOUCH_KEYS.map((k) => k.name);
    expect(names).toEqual(expect.arrayContaining(['up', 'down', 'enter', 'escape']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every button a name a screen reader can say', () => {
    for (const k of TOUCH_KEYS) expect(k.title.length).toBeGreaterThan(0);
  });
});
