#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearServerState, dataDir, logPath, readServerState, type ServerState } from '../server/config.js';
import { DEFAULT_PORT, startServer } from '../server/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

const USAGE = `TTC

Usage:
  ttc start           Start the server in the background (if needed) and open the browser
  ttc                 The same as ttc start
  ttc --port <n>      Start on this port, or the next free one (default ${DEFAULT_PORT})
  ttc --no-open       Do not open the browser
  ttc --foreground    Run attached to this terminal, with logs on screen
  ttc status          Say whether the server is running
  ttc stop            Stop the server and every session it hosts
  ttc --version       Print the version
  ttc --help          Print this help`;

type Out = (line: string) => void;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function version(): string {
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * True only if a TTC server answers on the recorded port. The recorded pid is not trusted:
 * after a crash or a reboot it may belong to some other program.
 */
type Probe = 'ours' | 'other' | 'unreachable';

/**
 * Asks the recorded port who is there. "ours" only if the very server that wrote the state
 * file answers (same start time): after a crash the port may be taken by another program,
 * or by another TTC instance, whose token we do not hold and whose pid is not the recorded one.
 */
async function probe(state: ServerState): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return 'unreachable';
  }
  try {
    if (!res.ok) return 'other';
    const body = (await res.json()) as { ok?: unknown; app?: unknown; startedAt?: unknown };
    return body.ok === true && body.app === 'ttc' && body.startedAt === state.startedAt ? 'ours' : 'other';
  } catch {
    return 'other';
  }
}

export async function isServerAlive(state: ServerState): Promise<boolean> {
  return (await probe(state)) === 'ours';
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function liveState(): Promise<ServerState | null> {
  const state = readServerState();
  if (!state) return null;
  // A busy server can miss one health check. While its process exists, ask again before
  // calling it gone: starting a second server would strand the first with its sessions.
  for (let attempt = 0; attempt < 3; attempt++) {
    const who = await probe(state);
    if (who === 'ours') return state;
    if (who === 'other' || !pidAlive(state.pid)) return null;
    await sleep(300);
  }
  return null;
}

function launchUrl(state: ServerState): string {
  return `http://127.0.0.1:${state.port}/#token=${state.token}`;
}

/**
 * Writes a private page that sends the browser to the server with its token. The browser is
 * started on this file, not on the address: command lines are visible to other users of the
 * machine, and the token is all it takes to get a shell here.
 */
export function writeLauncherPage(state: ServerState): string {
  const file = join(dataDir(), 'open.html');
  // In the fragment the token is not sent to any server, not even ours; the page reads it.
  const url = launchUrl(state);
  rmSync(file, { force: true });
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>TTC</title><meta http-equiv="refresh" content="0;url=${url}"><script>location.replace(${JSON.stringify(url)})</script>`,
    { mode: 0o600 },
  );
  return file;
}

async function openBrowserOn(state: ServerState, out: Out): Promise<void> {
  try {
    const { default: open } = await import('open');
    await open(writeLauncherPage(state));
  } catch (e) {
    out(`Could not open the browser (${(e as Error).message}). Open this address yourself:`);
    out(launchUrl(state));
  }
}

function tailLog(lines: number): string {
  try {
    return readFileSync(logPath(), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Starts the server as a background process. `node` is the program that runs it: this very
 * process by default, but the desktop app passes the real Node, because inside Electron
 * process.execPath is the app itself and the server hands that path to Claude Code's hooks.
 */
function spawnDetachedServer(port: number, node: string = process.execPath): void {
  const built = join(here, '..', 'server', 'index.js');
  // Running from source (development) goes through tsx; the published package is plain JS.
  const args = existsSync(built) ? [built] : ['--import', 'tsx', join(here, '..', 'server', 'index.ts')];
  const log = openSync(logPath(), 'a');
  const child = spawn(node, [...args, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
}

export type EnsureResult = { ok: true; state: ServerState } | { ok: false; error: string };

/**
 * Returns the running server, starting one in the background first if there is none.
 * Used by `ttc start` and by the desktop app, which passes the Node program to run it with.
 */
export async function ensureServer(options: { port?: number; node?: string } = {}): Promise<EnsureResult> {
  let state = await liveState();
  if (!state) {
    clearServerState();
    spawnDetachedServer(options.port ?? DEFAULT_PORT, options.node);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!state && Date.now() < deadline) {
      await sleep(150);
      state = await liveState();
    }
    if (!state) return { ok: false, error: `TTC did not start. Last lines of the log:
${tailLog(15) || `(no log at ${logPath()})`}` };
  }
  return { ok: true, state };
}

async function start(port: number, openBrowser: boolean, out: Out): Promise<number> {
  const started = await ensureServer({ port });
  if (!started.ok) {
    out(started.error);
    return 1;
  }
  const state = started.state;
  const base = `http://127.0.0.1:${state.port}`;
  out(`TTC running at ${base}`);
  if (openBrowser) await openBrowserOn(state, out);
  return 0;
}

async function status(out: Out): Promise<number> {
  const state = await liveState();
  if (!state) {
    out('TTC is not running.');
    return 1;
  }
  let count = '?';
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/sessions`, {
      headers: { 'x-ttc-token': state.token },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) count = String(((await res.json()) as unknown[]).length);
  } catch {
    // The count is a courtesy; the server did answer the health check.
  }
  out(`TTC is running at http://127.0.0.1:${state.port} (${count} sessions, pid ${state.pid}).`);
  return 0;
}

async function stop(out: Out): Promise<number> {
  const state = await liveState();
  if (!state) {
    clearServerState();
    out('TTC is not running.');
    return 0;
  }
  try {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-ttc-token': state.token },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Fall through to the check below.
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isServerAlive(state))) {
      clearServerState();
      out('TTC stopped.');
      return 0;
    }
    await sleep(150);
  }
  // The server that wrote the state file is still answering on its port (same start time),
  // so the recorded pid is that server and nothing else: safe to kill.
  try {
    process.kill(state.pid);
  } catch {
    // Already gone.
  }
  clearServerState();
  out('TTC did not stop on request and was terminated.');
  return 0;
}

export async function main(argv: string[], out: Out = console.log): Promise<number> {
  let command: 'start' | 'status' | 'stop' = 'start';
  let port = DEFAULT_PORT;
  let openBrowser = true;
  let foreground = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      out(USAGE);
      return 0;
    }
    if (a === '--version' || a === '-v') {
      out(version());
      return 0;
    }
    if (a === '--no-open') openBrowser = false;
    else if (a === '--foreground') foreground = true;
    else if (a === '--port') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        out('--port needs a number between 1 and 65535.');
        return 1;
      }
      port = n;
    } else if (a === 'status' || a === 'stop' || a === 'start') command = a;
    else {
      out(`Unknown argument: ${a}\n\n${USAGE}`);
      return 1;
    }
  }

  if (command === 'status') return status(out);
  if (command === 'stop') return stop(out);

  if (foreground) {
    const existing = await liveState();
    if (existing) {
      out(`TTC is already running at http://127.0.0.1:${existing.port}. Stop it first with: ttc stop`);
      return 1;
    }
    // One failing session must not take the server, and every other session, down with it.
    process.on('uncaughtException', (e) => console.error(`uncaught: ${e.stack ?? e}`));
    process.on('unhandledRejection', (e) => console.error(`unhandled: ${String(e)}`));
    const running = await startServer({ port });
    const shutdown = (): void => void running.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    out(`TTC running at http://127.0.0.1:${running.port} (Ctrl+C to stop)`);
    const state = readServerState();
    if (openBrowser && state) await openBrowserOn(state, out);
    await running.stopped;
    return 0;
  }

  return start(port, openBrowser, out);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error((e as Error).message ?? e);
      process.exit(1);
    },
  );
}
