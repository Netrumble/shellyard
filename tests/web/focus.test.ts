import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToDigest, digestText, focusOn, loadFocus, minutesLeft, saveFocus, splitForFocus, startFocus } from '../../src/web/focus.js';
import { session } from './session-fixture.js';

const MIN = 60_000;

describe('focus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lasts 45 minutes, and says the minutes left', () => {
    const f = startFocus(0);
    expect(focusOn(f, 44 * MIN)).toBe(true);
    expect(focusOn(f, 45 * MIN)).toBe(false);
    expect(focusOn(null, 0)).toBe(false);
    expect(minutesLeft(f, 0)).toBe(45);
    expect(minutesLeft(f, 44 * MIN + 59_000)).toBe(1);
  });

  it('lets permissions and questions interrupt, and keeps finished sessions and guesses for the digest', () => {
    const blocked = session('b', 'attention', 'blocked');
    const maybe = session('m', 'attention', 'maybe-waiting');
    const done = session('f', 'attention', 'finished');
    expect(splitForFocus([blocked, maybe, done], true)).toEqual({ interrupt: [blocked], digest: [maybe, done] });
    expect(splitForFocus([blocked, done], false)).toEqual({ interrupt: [blocked, done], digest: [] });
  });

  it('keeps each session once in the digest', () => {
    expect(addToDigest(['a'], ['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('says what finished, in a sentence', () => {
    expect(digestText([])).toBe('Nothing finished or went quiet while you focused.');
    expect(digestText(['Triage'])).toBe('While you focused, 1 session finished or went quiet: Triage.');
    expect(digestText(['A', 'B', 'C'])).toBe('While you focused, 3 sessions finished or went quiet: A, B and C.');
  });

  it('is remembered by this browser until it ends, and survives a broken storage', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    const f = startFocus(1000);
    saveFocus(f);
    expect(loadFocus(2000)).toEqual(f);
    expect(loadFocus(f.until)).toBeNull();
    saveFocus(null);
    expect(loadFocus(2000)).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadFocus(0)).toBeNull();
    expect(() => saveFocus(f)).not.toThrow();
  });
});
