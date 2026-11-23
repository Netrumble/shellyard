import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { Launch } from '../src/server/shells.js';
import type { PtyFactory, PtyLike } from '../src/server/pty-session.js';

/**
 * Deletes a test folder. On Windows a folder stays busy for a moment after a process that worked
 * in it ends (the git processes the server starts in a session's folder), so the deletion is
 * tried again for up to six seconds. The loop is done here: rmSync's own maxRetries does not
 * retry on Windows with every Node version.
 */
export function removeDir(dir: string): void {
  const until = Date.now() + 6000;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(code ?? '') || Date.now() > until) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** Gives each test its own data folder through SHELLYARD_HOME, so the real one is never touched. */
export function useTempHome(): { dir: () => string } {
  let dir = '';
  let previous: string | undefined;
  let previousClaude: string | undefined;
  beforeEach(() => {
    previous = process.env.SHELLYARD_HOME;
    previousClaude = process.env.CLAUDE_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), 'shellyard-test-'));
    process.env.SHELLYARD_HOME = dir;
    // Stands in for ~/.claude: a server under test must not read the real conversations.
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config');
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SHELLYARD_HOME;
    else process.env.SHELLYARD_HOME = previous;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    removeDir(dir);
  });
  return { dir: () => dir };
}

export class FakePty implements PtyLike {
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number }) => void> = [];
  constructor(
    readonly launch: Launch,
    readonly opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
  ) {}
  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb);
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    this.exit(0);
  }
  emit(d: string): void {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(code: number): void {
    const cbs = this.exitCbs;
    this.exitCbs = [];
    for (const cb of cbs) cb({ exitCode: code });
  }
}

export function fakePtyFactory(): { factory: PtyFactory; ptys: FakePty[]; last: () => FakePty } {
  const ptys: FakePty[] = [];
  const factory: PtyFactory = (launch, opts) => {
    const p = new FakePty(launch, opts);
    ptys.push(p);
    return p;
  };
  return {
    factory,
    ptys,
    last: () => {
      const p = ptys[ptys.length - 1];
      if (!p) throw new Error('no pty was created');
      return p;
    },
  };
}

export class FakeClock {
  private t = 1_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
