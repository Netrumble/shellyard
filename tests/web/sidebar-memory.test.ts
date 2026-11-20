import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFlag, writeFlag } from '../../src/web/sidebar-memory.js';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
}

describe('sidebar memory flags', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is false until written, then remembers true and false', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(readFlag('shellyard-sidebar-folded')).toBe(false);
    writeFlag('shellyard-sidebar-folded', true);
    expect(readFlag('shellyard-sidebar-folded')).toBe(true);
    writeFlag('shellyard-sidebar-folded', false);
    expect(readFlag('shellyard-sidebar-folded')).toBe(false);
  });

  it('survives a localStorage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readFlag('shellyard-sessions-folded')).toBe(false);
    expect(() => writeFlag('shellyard-sessions-folded', true)).not.toThrow();
  });
});
