import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeDirPatiently } from '../../src/server/remove-dir.js';

const busy = (): never => {
  throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
};

/** A clock that moves only when the code under test sleeps. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)), slept };
}

describe('removeDirPatiently', () => {
  it('deletes a real folder and what is in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellyard-remove-'));
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x');
    expect(await removeDirPatiently(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('tries again while the folder is busy, then succeeds', async () => {
    const c = clock();
    let calls = 0;
    let gone = false;
    const rm = (): void => {
      calls += 1;
      if (calls < 3) busy();
      gone = true;
    };
    expect(await removeDirPatiently('/x', { rm, exists: () => !gone, ...c })).toBe(true);
    expect(calls).toBe(3);
    expect(c.slept).toEqual([100, 100]);
  });

  it('gives up after the time allowed and says the folder is still there', async () => {
    const c = clock();
    let calls = 0;
    const rm = (): void => {
      calls += 1;
      busy();
    };
    expect(await removeDirPatiently('/x', { rm, exists: () => true, timeoutMs: 1000, ...c })).toBe(false);
    expect(calls).toBe(11);
  });

  it('does not try again on an error that is not about a busy folder', async () => {
    const c = clock();
    let calls = 0;
    const rm = (): void => {
      calls += 1;
      throw Object.assign(new Error('ENAMETOOLONG'), { code: 'ENAMETOOLONG' });
    };
    expect(await removeDirPatiently('/x', { rm, exists: () => true, ...c })).toBe(false);
    expect(calls).toBe(1);
  });
});
