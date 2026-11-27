import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

// One server per data folder. Two servers on one folder would each restore the sessions of the
// last run, so every Claude Code conversation would be resumed twice, by processes that do not
// know of each other (and the second server, on the next free port, would be out of sight).
// Starts that race each other (an app asked twice to open while its server is starting, two
// `shellyard` in two terminals) all find no server running, so the check has to be the start
// itself: the server listens on a local socket of its folder, and only one process can. The
// system frees it when the process ends, however it ends.
//
// The socket is named after an id kept in the folder, random and made once, not after the
// folder's path: every spelling of the folder (a short name, a link, a mapped drive) reads the
// same id, and no other user, who cannot read the folder, can guess the name and hold it first.
// It lives in the temporary folder, where a socket can always be made and its name always fits
// (a data folder can be on a file system without sockets, or too deep for their name length).

const ID_FILE = 'instance.id';
const ID = /^[0-9a-f]{32}$/;

/** What a holder says of itself when asked. */
export interface Holder {
  pid: number;
  /** Its HTTP port; null while it is still starting. */
  port: number | null;
}

/** Thrown when another live process holds the folder. */
export class InstanceHeldError extends Error {
  readonly code = 'SHELLYARD_ALREADY_RUNNING';
  /** Who holds it; null when the holder does not say (busy, or not ShellYard). */
  readonly holder: Holder | null;

  constructor(dir: string, holder: Holder | null) {
    super(
      holder
        ? `ShellYard is already running on ${dir} (pid ${holder.pid}${holder.port === null ? ', starting' : `, port ${holder.port}`}). Stop it first with: shellyard stop`
        : `Another process holds the data folder ${dir} and does not answer. If no ShellYard is running, end the process that holds it.`,
    );
    this.name = 'InstanceHeldError';
    this.holder = holder;
  }
}

export function isInstanceHeld(e: unknown): e is InstanceHeldError {
  return (e as { code?: unknown } | null)?.code === 'SHELLYARD_ALREADY_RUNNING';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The id of a data folder, made the first time it is asked for. Made with an exclusive create,
 * so starts that race each other all end up with the one id written first.
 */
export async function folderId(dir: string): Promise<string> {
  const file = join(dir, ID_FILE);
  for (let attempt = 0; attempt < 50; attempt++) {
    let text: string | null = null;
    try {
      text = readFileSync(file, 'utf8').trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (text !== null && ID.test(text)) return text;
    if (text === null) {
      try {
        writeFileSync(file, randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 });
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    // Just created by another start, which has not written it yet.
    await sleep(20);
  }
  throw new Error(`${file} is not a ShellYard instance id: remove it and start again.`);
}

/** The local socket of a folder's id: a named pipe on Windows, a socket file elsewhere. */
export function lockAddress(id: string, platform: NodeJS.Platform = process.platform, tmp: string = tmpdir()): string {
  return platform === 'win32' ? `\\\\.\\pipe\\shellyard-${id}` : posix.join(tmp, `shellyard-${id}.sock`);
}

/**
 * Connect errors that mean nobody listens. Any other (a full backlog, no rights, too many open
 * files, a timeout) can come from a live holder, so it is never taken for a dead one.
 */
const NOBODY = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

/**
 * Asks the holder of an address who it is; with `state`, it writes its state file again first.
 * 'dead' when nobody listens; 'unknown' when something listens but does not say who it is in time.
 */
export function askHolder(address: string, request: 'who' | 'state', timeoutMs = 2000): Promise<Holder | 'dead' | 'unknown'> {
  return new Promise((done) => {
    let settled = false;
    const socket: Socket = connect(address);
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    function finish(r: Holder | 'dead' | 'unknown'): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(r);
    }
    let text = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${request}\n`));
    socket.on('data', (d: string) => {
      text += d;
      const end = text.indexOf('\n');
      if (end < 0) return;
      try {
        const m = JSON.parse(text.slice(0, end)) as { app?: unknown; pid?: unknown; port?: unknown };
        const port = m.port === null || Number.isInteger(m.port) ? (m.port as number | null) : undefined;
        finish(m.app === 'shellyard' && Number.isInteger(m.pid) && port !== undefined ? { pid: m.pid as number, port } : 'unknown');
      } catch {
        finish('unknown');
      }
    });
    socket.once('end', () => finish('unknown'));
    socket.once('error', (e: NodeJS.ErrnoException) => finish(e.code && NOBODY.has(e.code) ? 'dead' : 'unknown'));
  });
}

export interface InstanceLock {
  readonly address: string;
  /** What the holder answers once its server is up; `restate` writes its state file again. */
  serve(info: { port: number; restate: () => void }): void;
  release(): Promise<void>;
}

interface Answer {
  port: number | null;
  restate: (() => void) | null;
}

function lockServer(answer: Answer): Server {
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let text = '';
    let replied = false;
    const reply = (request: string): void => {
      if (replied) return;
      replied = true;
      clearTimeout(timer);
      if (request === 'state') {
        try {
          answer.restate?.();
        } catch {
          // Answered all the same: who holds the folder is still worth saying.
        }
      }
      socket.end(`${JSON.stringify({ app: 'shellyard', pid: process.pid, port: answer.port })}\n`);
    };
    const timer = setTimeout(() => reply(''), 1000);
    socket.on('data', (d: string) => {
      text += d;
      const end = text.indexOf('\n');
      if (end >= 0) reply(text.slice(0, end).trim());
    });
    socket.on('close', () => clearTimeout(timer));
  });
  server.unref();
  return server;
}

/** A server listening on the address for this process; null when the address is in use. */
function tryListen(answer: Answer, address: string): Promise<Server | null> {
  const server = lockServer(answer);
  return new Promise((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      if (e.code === 'EADDRINUSE') ok(null);
      else fail(new Error(`ShellYard cannot make its lock ${address}: ${e.message}`, { cause: e }));
    };
    server.once('error', onError);
    server.listen(address, () => {
      server.off('error', onError);
      ok(server);
    });
  });
}

/** A takeover guard older than this was left by a start that was killed in the middle. */
const STALE_GUARD_MS = 10_000;

/**
 * Takes over the socket file of a server that was killed (outside Windows), under a guard file
 * made with an exclusive create: two starts must not both remove the file and listen, the second
 * one removing the first one's live socket. Under the guard, the file is probed again.
 */
async function takeOver(answer: Answer, address: string): Promise<Server | null> {
  const guard = `${address}.takeover`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      if (Date.now() - statSync(guard).mtimeMs > STALE_GUARD_MS) unlinkSync(guard);
    } catch {
      // Gone meanwhile.
    }
    return null;
  }
  try {
    if ((await askHolder(address, 'who')) !== 'dead') return null;
    try {
      unlinkSync(address);
    } catch {
      // Already gone.
    }
    return await tryListen(answer, address);
  } finally {
    closeSync(fd);
    try {
      unlinkSync(guard);
    } catch {
      // Nothing to do.
    }
  }
}

/** How often the socket file is touched, so that no cleaner of the temporary folder removes it. */
const TOUCH_MS = 60 * 60 * 1000;

/**
 * Takes the folder for this process. Throws InstanceHeldError when a live process holds it,
 * after waiting up to `waitMs` for it to let go (a server being replaced may still be closing).
 */
export async function acquireInstanceLock(
  dir: string,
  opts: { waitMs?: number; platform?: NodeJS.Platform; tmp?: string } = {},
): Promise<InstanceLock> {
  const platform = opts.platform ?? process.platform;
  const address = lockAddress(await folderId(dir), platform, opts.tmp);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const answer: Answer = { port: null, restate: null };
  let server: Server | null = null;
  for (let round = 0; !server; round++) {
    server = await tryListen(answer, address);
    if (server) break;
    const holder = await askHolder(address, 'who');
    if (holder === 'dead' && platform !== 'win32') server = await takeOver(answer, address);
    if (server) break;
    // A dead socket another start is taking over is settled within a few rounds.
    if ((holder !== 'dead' || round >= 20) && Date.now() >= deadline) throw new InstanceHeldError(dir, typeof holder === 'object' ? holder : null);
    await sleep(holder === 'dead' ? 50 : 200);
  }
  let current: Server = server;

  let touch: NodeJS.Timeout | null = null;
  if (platform !== 'win32') {
    touch = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(address, now, now);
      } catch {
        // Removed from under us: listen again, unless another process has taken it meanwhile.
        // The old server is left open: closing it would remove the file by its name, the new one's.
        void tryListen(answer, address).then(
          (again) => {
            if (again) current = again;
          },
          () => {},
        );
      }
    }, TOUCH_MS);
    touch.unref();
  }

  let released: Promise<void> | null = null;
  return {
    address,
    serve(info) {
      answer.port = info.port;
      answer.restate = info.restate;
    },
    release() {
      released ??= new Promise((r) => {
        if (touch) clearInterval(touch);
        current.close(() => r());
      });
      return released;
    },
  };
}
