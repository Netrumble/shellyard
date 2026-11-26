import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { posix, win32 } from 'node:path';

// One server per data folder. Two servers on one folder would each restore the sessions of the
// last run, so every Claude Code conversation would be resumed twice, by processes that do not
// know of each other (and the second server, on the next free port, would be out of sight).
// Starts that race each other (an app asked twice to open while its server is starting, two
// `shellyard` in two terminals) all find no server running, so the check has to be the start
// itself: the server holds a local socket named after its folder, and only one process can
// listen on it. The system frees it when the process ends, however it ends.

/** The local socket of a data folder: a named pipe on Windows, a socket file in it elsewhere. */
export function lockAddress(dir: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === 'win32' ? win32 : posix;
  const folder = path.resolve(dir);
  if (platform === 'win32') {
    // Pipe names are not paths, and Windows folder names are not case-sensitive.
    const id = createHash('sha256').update(folder.toLowerCase()).digest('hex').slice(0, 32);
    return `\\\\.\\pipe\\shellyard-${id}`;
  }
  return path.join(folder, 'server.lock');
}

export interface InstanceLock {
  release(): Promise<void>;
}

function listenOn(server: Server, address: string): Promise<void> {
  return new Promise((ok, fail) => {
    const onError = (e: Error): void => fail(e);
    server.once('error', onError);
    server.listen(address, () => {
      server.off('error', onError);
      ok();
    });
  });
}

/** True when a process answers on the address (the socket of a live server). */
function answers(address: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(address);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

/**
 * Takes the folder for this process, or returns null when a live server holds it. A socket
 * file left by a server that was killed (outside Windows) is taken over.
 */
export async function acquireInstanceLock(dir: string, platform: NodeJS.Platform = process.platform): Promise<InstanceLock | null> {
  const address = lockAddress(dir, platform);
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = createServer((socket) => socket.destroy());
    server.unref();
    try {
      await listenOn(server, address);
      return { release: () => new Promise((r) => server.close(() => r())) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
    if (platform === 'win32' || (await answers(address))) return null;
    // Nobody listens: the file of a server that was killed. Only one start can take it over,
    // since only one can listen once it is gone.
    try {
      unlinkSync(address);
    } catch {
      // Removed meanwhile by another start: try again all the same.
    }
  }
  return null;
}
