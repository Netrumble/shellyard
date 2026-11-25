import { describe, expect, it } from 'vitest';
import { TOUCH_KEYS, touchKeySequence } from '../../src/web/touch-keys.js';

describe('touchKeySequence', () => {
  it('sends arrows in normal cursor mode', () => {
    expect(touchKeySequence('up', false)).toBe('\x1b[A');
    expect(touchKeySequence('down', false)).toBe('\x1b[B');
    expect(touchKeySequence('right', false)).toBe('\x1b[C');
    expect(touchKeySequence('left', false)).toBe('\x1b[D');
  });

  it('sends arrows in application cursor mode when the program asked for it', () => {
    expect(touchKeySequence('down', true)).toBe('\x1bOB');
    expect(touchKeySequence('up', true)).toBe('\x1bOA');
  });

  it('sends the other keys as a keyboard would', () => {
    expect(touchKeySequence('esc', false)).toBe('\x1b');
    expect(touchKeySequence('tab', false)).toBe('\t');
    expect(touchKeySequence('shift-tab', false)).toBe('\x1b[Z');
    expect(touchKeySequence('enter', true)).toBe('\r');
    expect(touchKeySequence('ctrl-c', false)).toBe('\x03');
  });

  it('has a sequence for every key on the bar', () => {
    for (const k of TOUCH_KEYS) expect(touchKeySequence(k.key, false)).not.toBe('');
  });
});
