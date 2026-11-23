import { existsSync, rmSync } from 'node:fs';

/** What a folder still held by a process answers on Windows, for a moment after the process ends. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

export interface RemoveDirSeams {
  rm?: (path: string) => void;
  exists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Deletes a folder and what is in it, trying again while it is busy, for up to `timeoutMs`; true
 * when it is gone. The tries are made here: rmSync's own maxRetries does not retry on Windows
 * with every Node version, and gives up at once on a folder a process left a moment ago. The
 * waits do not block the server.
 */
export async function removeDirPatiently(path: string, o: { timeoutMs?: number; delayMs?: number } & RemoveDirSeams = {}): Promise<boolean> {
  const rm = o.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const exists = o.exists ?? existsSync;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const until = now() + (o.timeoutMs ?? 3000);
  const delayMs = o.delayMs ?? 100;
  for (;;) {
    try {
      rm(path);
      return !exists(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!BUSY_CODES.has(code) || now() >= until) return !exists(path);
      await sleep(delayMs);
    }
  }
}
