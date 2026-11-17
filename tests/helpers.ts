import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { Launch } from '../src/server/shells.js';
import type { PtyFactory, PtyLike } from '../src/server/pty-session.js';

/** Gives each test its own data folder through CVM_HOME, so the real one is never touched. */
export function useTempHome(): { dir: () => string } {
  let dir = '';
  let previous: string | undefined;
  let previousClaude: string | undefined;
  beforeEach(() => {
    previous = process.env.CVM_HOME;
    previousClaude = process.env.CLAUDE_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), 'cvm-test-'));
    process.env.CVM_HOME = dir;
    // Stands in for ~/.claude: a server under test must not read the real conversations.
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config');
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CVM_HOME;
    else process.env.CVM_HOME = previous;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    rmSync(dir, { recursive: true, force: true });
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
