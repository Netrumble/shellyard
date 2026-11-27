import { describe, expect, it } from 'vitest';
import { pressOnControl } from '../../src/web/components/drag-target.js';

/** An element as far as `closest` goes: its tag and its ancestors' tags. */
function element(path: string[]): EventTarget {
  return { closest: (selector: string) => (path.some((tag) => selector.split(', ').includes(tag)) ? {} : null) } as unknown as EventTarget;
}

describe('pressOnControl', () => {
  it('is true on a control of the header, or inside one', () => {
    expect(pressOnControl(element(['button']))).toBe(true);
    expect(pressOnControl(element(['span', 'button']))).toBe(true);
    expect(pressOnControl(element(['select']))).toBe(true);
    expect(pressOnControl(element(['input']))).toBe(true);
  });

  it('is false on the rest of the header, and for something that is not an element', () => {
    expect(pressOnControl(element(['span', 'header']))).toBe(false);
    expect(pressOnControl(null)).toBe(false);
    expect(pressOnControl({} as EventTarget)).toBe(false);
  });
});
