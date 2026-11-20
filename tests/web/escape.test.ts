import { describe, expect, it, vi } from 'vitest';
import { handleEscape, pushEscape } from '../../src/web/escape.js';

const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe('escape stack', () => {
  it('closes only the newest dialog, then the one under it', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const popOuter = pushEscape(outer);
    const popInner = pushEscape(inner);
    const e = key('Escape');
    expect(handleEscape(e)).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    // The key goes no further: other listeners (older dialogs, the terminal) do not see it.
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
    popInner();
    handleEscape(key('Escape'));
    expect(outer).toHaveBeenCalledTimes(1);
    popOuter();
  });

  it('ignores other keys, and Escape with no dialog open', () => {
    const close = vi.fn();
    const pop = pushEscape(close);
    expect(handleEscape(key('Enter'))).toBe(false);
    expect(close).not.toHaveBeenCalled();
    pop();
    const e = key('Escape');
    expect(handleEscape(e)).toBe(false);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('takes out the right dialog when an older one closes first', () => {
    const a = vi.fn();
    const b = vi.fn();
    const popA = pushEscape(a);
    const popB = pushEscape(b);
    popA();
    handleEscape(key('Escape'));
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    popB();
    popA();
  });
});
