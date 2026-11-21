#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearServerState, dataDir, launcherPagePath, logPath, readServerState, type ServerState } from '../server/config.js';
import { healthProof, newChallenge, safeEqual } from '../server/auth.js';
import { DEFAULT_PORT, reportUncaught, startServer } from '../server/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

const USAGE = `ShellYard

Usage:
  shellyard start           Start the server in the background (if needed) and open the browser
  shellyard                 The same as shellyard start
  shellyard --port <n>      Start on this port, or the next free one (default ${DEFAULT_PORT})
  shellyard --no-open       Do not open the browser
  shellyard --foreground    Run attached to this terminal, with logs on screen
  shellyard status          Say whether the server is running
  shellyard stop            Stop the server and every session it hosts
  shellyard --version       Print the version
  shellyard --help          Print this help`;

type Out = (line: string) => void;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function version(): string {
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * True only if a ShellYard server answers on the recorded port. The recorded pid is not trusted:
 * after a crash or a reboot it may belong to some other program.
 */
type Probe = 'ours' | 'other' | 'unreachable';

/**
 * Asks the recorded port who is there. "ours" only if the very server that wrote the state
 * file answers: after a crash the port may be taken by another program, or by another
 * ShellYard instance, whose token we do not hold and whose pid is not the recorded one. That
 * server proves it holds the recorded token by answering a fresh challenge; the token itself is
 * never sent before that, so a stranger on the port learns nothing it could use.
 */
async function probe(state: ServerState): Promise<{ who: Probe; version: string | null }> {
  const challenge = newChallenge();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${state.port}/api/health?challenge=${challenge}`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return { who: 'unreachable', version: null };
  }
  try {
    if (!res.ok) return { who: 'other', version: null };
    const body = (await res.json()) as { ok?: unknown; app?: unknown; proof?: unknown; version?: unknown; startedAt?: unknown };
    const proven = typeof body.proof === 'string' && safeEqual(body.proof, healthProof(state.token, challenge));
    // Servers up to 0.1.2 cannot answer the challenge and named their start time instead. That
    // is still accepted, so that an update can stop the server it replaces, but only for a state
    // file such a server wrote (it has no page host): one written by a newer server is always
    // proven with the challenge.
    const legacy = state.pageHost === undefined && body.proof === undefined && typeof body.startedAt === 'number' && body.startedAt === state.startedAt;
    const ours = body.ok === true && body.app === 'shellyard' && (proven || legacy);
    return ours ? { who: 'ours', version: typeof body.version === 'string' ? body.version : null } : { who: 'other', version: null };
  } catch {
    return { who: 'other', version: null };
  }
}

export async function isServerAlive(state: ServerState): Promise<boolean> {
  return (await probe(state)).who === 'ours';
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
    const { who } = await probe(state);
    if (who === 'ours') return state;
    if (who === 'other' || !pidAlive(state.pid)) return null;
    await sleep(300);
  }
  return null;
}

/**
 * Where the page of a server is: its own host name of this start (a server up to 0.1.2 has
 * none and serves on 127.0.0.1). The command itself always talks to 127.0.0.1.
 */
export function pageAddress(state: Pick<ServerState, 'port' | 'pageHost'>): string {
  return `http://${state.pageHost ?? '127.0.0.1'}:${state.port}`;
}

function launchUrl(state: ServerState): string {
  return `${pageAddress(state)}/#token=${state.token}`;
}

/**
 * Writes a private page that sends the browser to the server with its token. The browser is
 * started on this file, not on the address: command lines are visible to other users of the
 * machine, and the token is all it takes to get a shell here.
 */
export function writeLauncherPage(state: ServerState): string {
  const file = launcherPagePath();
  // In the fragment the token is not sent to any server, not even ours; the page reads it.
  const url = launchUrl(state);
  rmSync(file, { force: true });
  writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>ShellYard</title><meta http-equiv="refresh" content="0;url=${url}"><script>location.replace(${JSON.stringify(url)})</script>`,
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
  // tsx is named by its full address: the server does not start in this package's folder.
  const args = existsSync(built) ? [built] : ['--import', import.meta.resolve('tsx'), join(here, '..', 'server', 'index.ts')];
  const log = openSync(logPath(), 'a');
  const child = spawn(node, [...args, '--port', String(port)], {
    detached: true,
    // Not the folder the command was typed in: on Windows a program named like one the server
    // starts (wsl.exe, cmd.exe) would be found there first, and the server lives on for days.
    cwd: dataDir(),
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
}

/**
 * The version our server reports, or null when it does not say (servers before this check),
 * cannot be reached, or is not ours.
 */
export async function serverVersion(state: ServerState): Promise<string | null> {
  return (await probe(state)).version;
}

export type EnsureResult =
  | {
      ok: true;
      state: ServerState;
      /** The version of the running server; null if it is older than version reporting. */
      serverVersion: string | null;
      /** The version of this package, the one a new server would run. */
      appVersion: string;
      /**
       * True when the server already running is another version. It was started from files an
       * update may have replaced or removed, so its page can be broken until it is restarted.
       */
      outdated: boolean;
    }
  | { ok: false; error: string };

/**
 * Returns the running server, starting one in the background first if there is none.
 * Used by `shellyard start` and by the desktop app, which passes the Node program to run it with.
 */
export async function ensureServer(options: { port?: number; node?: string } = {}): Promise<EnsureResult> {
  const started = await ensureRunning(options);
  if (!started.ok) return started;
  const appVersion = version();
  const running = await serverVersion(started.state);
  return { ok: true, state: started.state, serverVersion: running, appVersion, outdated: running !== appVersion };
}

/**
 * Stops the running server and starts the one of this package. The sessions open in the old
 * server are started again by the new one, as after any stop; what was running inside them ends.
 */
export async function restartServer(options: { port?: number; node?: string } = {}): Promise<EnsureResult> {
  const previous = readServerState();
  await stopServer();
  return ensureServer({ port: options.port ?? previous?.port, node: options.node });
}

async function ensureRunning(options: { port?: number; node?: string }): Promise<{ ok: true; state: ServerState } | { ok: false; error: string }> {
  let state = await liveState();
  if (!state) {
    clearServerState();
    spawnDetachedServer(options.port ?? DEFAULT_PORT, options.node);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!state && Date.now() < deadline) {
      await sleep(150);
      state = await liveState();
    }
    if (!state) {
      // The report holds the end of the log too, ready to read or attach to an issue.
      const report = reportUncaught('startup', new Error('ShellYard did not start in time'), `shellyard start, port ${options.port ?? DEFAULT_PORT}`);
      return {
        ok: false,
        error: `ShellYard did not start. Last lines of the log:
${tailLog(15) || `(no log at ${logPath()})`}${report ? `\n\nError report: ${report}` : ''}`,
      };
    }
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
  const base = pageAddress(state);
  out(`ShellYard running at ${base}`);
  if (started.outdated) {
    out(
      `This server runs ShellYard ${started.serverVersion ?? 'from an earlier version'}, not ${started.appVersion}. ` +
        'Restart it to use this version: shellyard stop, then shellyard. Open sessions are started again.',
    );
  }
  if (openBrowser) await openBrowserOn(state, out);
  return 0;
}

async function status(out: Out): Promise<number> {
  const state = await liveState();
  if (!state) {
    out('ShellYard is not running.');
    return 1;
  }
  let count = '?';
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/sessions`, {
      headers: { 'x-shellyard-token': state.token },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) count = String(((await res.json()) as unknown[]).length);
  } catch {
    // The count is a courtesy; the server did answer the health check.
  }
  out(`ShellYard is running at ${pageAddress(state)} (${count} sessions, pid ${state.pid}).`);
  return 0;
}

async function stop(out: Out): Promise<number> {
  const result = await stopServer();
  out(
    result === 'not-running'
      ? 'ShellYard is not running.'
      : result === 'stopped'
        ? 'ShellYard stopped.'
        : 'ShellYard did not stop on request and was terminated.',
  );
  return 0;
}

/** Stops the running server, if any, and every session it hosts. */
export async function stopServer(): Promise<'not-running' | 'stopped' | 'terminated'> {
  const state = await liveState();
  if (!state) {
    clearServerState();
    return 'not-running';
  }
  try {
    await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'x-shellyard-token': state.token },
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Fall through to the check below.
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isServerAlive(state))) {
      clearServerState();
      return 'stopped';
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
  return 'terminated';
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
      out(`ShellYard is already running at ${pageAddress(existing)}. Stop it first with: shellyard stop`);
      return 1;
    }
    // One failing session must not take the server, and every other session, down with it.
    process.on('uncaughtException', (e) => console.error(`uncaught: ${e.stack ?? e}`));
    process.on('unhandledRejection', (e) => console.error(`unhandled: ${String(e)}`));
    const running = await startServer({ port });
    const shutdown = (): void => void running.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    out(`ShellYard running at ${pageAddress(running)} (Ctrl+C to stop)`);
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
