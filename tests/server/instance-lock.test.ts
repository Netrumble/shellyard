import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { readServerState } from '../../src/server/config.js';
import {
  acquireInstanceLock,
  askHolder,
  folderId,
  InstanceHeldError,
  isInstanceHeld,
  lockAddress,
  type InstanceLock,
} from '../../src/server/instance-lock.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const ID = '0123456789abcdef0123456789abcdef';

describe('lockAddress', () => {
  it('is a named pipe on Windows, named after the folder id', () => {
    expect(lockAddress(ID, 'win32')).toBe(`\\\\.\\pipe\\shellyard-${ID}`);
  });

  it('is a socket file in the temporary folder elsewhere, whatever the depth of the data folder', () => {
    expect(lockAddress(ID, 'linux', '/tmp')).toBe(`/tmp/shellyard-${ID}.sock`);
  });
});

describe('folderId', () => {
  const home = useTempHome();

  it('is made once and kept in the folder', async () => {
    const id = await folderId(home.dir());
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(readFileSync(join(home.dir(), 'instance.id'), 'utf8')).toBe(id);
    expect(await folderId(home.dir())).toBe(id);
  });

  it('is the same for starts that race each other', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => folderId(home.dir())));
    expect(new Set(ids).size).toBe(1);
  });

  it('refuses a file that is not an id, instead of making a second one', async () => {
    writeFileSync(join(home.dir(), 'instance.id'), 'nonsense');
    await expect(folderId(home.dir())).rejects.toThrow(/not a ShellYard instance id/);
  });
});

describe('acquireInstanceLock', () => {
  const home = useTempHome();
  const held: InstanceLock[] = [];
  afterEach(async () => {
    for (const l of held.splice(0)) await l.release();
  });

  it('gives a folder to one holder at a time, and says who holds it', async () => {
    const first = await acquireInstanceLock(home.dir());
    held.push(first);
    const refused = await acquireInstanceLock(home.dir()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(InstanceHeldError);
    expect(isInstanceHeld(refused)).toBe(true);
    expect((refused as InstanceHeldError).holder).toEqual({ pid: process.pid, port: null });
    await first.release();
    held.splice(0);
    held.push(await acquireInstanceLock(home.dir()));
  });

  it('gives one of several starts racing each other the folder', async () => {
    const all = await Promise.allSettled([1, 2, 3, 4].map(() => acquireInstanceLock(home.dir())));
    const got = all.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    held.push(...got);
    expect(got).toHaveLength(1);
    for (const r of all) if (r.status === 'rejected') expect(isInstanceHeld(r.reason)).toBe(true);
  });

  it('waits for a holder that is letting go', async () => {
    const first = await acquireInstanceLock(home.dir());
    setTimeout(() => void first.release(), 300);
    held.push(await acquireInstanceLock(home.dir(), { waitMs: 3000 }));
  });

  it('answers who it is, and writes the state again when asked', async () => {
    const lock = await acquireInstanceLock(home.dir());
    held.push(lock);
    let restated = 0;
    lock.serve({ port: 7799, restate: () => restated++ });
    expect(await askHolder(lock.address, 'who')).toEqual({ pid: process.pid, port: 7799 });
    expect(restated).toBe(0);
    expect(await askHolder(lock.address, 'state')).toEqual({ pid: process.pid, port: 7799 });
    expect(restated).toBe(1);
  });

  it('takes nobody listening for dead', async () => {
    expect(await askHolder(lockAddress(ID, process.platform, home.dir()), 'who')).toBe('dead');
  });

  describe.skipIf(process.platform === 'win32')('a socket file left by a server that was killed', () => {
    it('is taken over', async () => {
      const id = await folderId(home.dir());
      writeFileSync(lockAddress(id), '');
      held.push(await acquireInstanceLock(home.dir()));
    });

    it('is taken over by one of several starts racing each other', async () => {
      const id = await folderId(home.dir());
      writeFileSync(lockAddress(id), '');
      const all = await Promise.allSettled([1, 2, 3, 4].map(() => acquireInstanceLock(home.dir())));
      const got = all.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      held.push(...got);
      expect(got).toHaveLength(1);
      expect(existsSync(`${lockAddress(id)}.takeover`)).toBe(false);
    });
  });
});

describe('startServer on a folder already in use', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it('refuses to start, so the sessions are not restored twice', async () => {
    const opts = { port: 0, ptyFactory: fakePtyFactory().factory, quiet: true };
    const results = await Promise.allSettled([startServer(opts), startServer(opts)]);
    for (const r of results) if (r.status === 'fulfilled') running.push(r.value);
    expect(running).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isInstanceHeld(refused.reason)).toBe(true);
    expect(String(refused.reason)).toMatch(/already running/);
    // Once stopped, the folder is free for the next start.
    await running.splice(0)[0]!.stop();
    running.push(await startServer(opts));
  }, 15_000);

  it('writes its state file again when a start that cannot find it asks', async () => {
    const server = await startServer({ port: 0, ptyFactory: fakePtyFactory().factory, quiet: true });
    running.push(server);
    const before = readServerState();
    writeFileSync(join(home.dir(), 'server.json'), '');
    const holder = await askHolder(lockAddress(await folderId(home.dir())), 'state');
    expect(holder).toEqual({ pid: process.pid, port: server.port });
    expect(readServerState()).toEqual(before);
  });

  it('leaves the folder free when it fails after taking it', async () => {
    await expect(startServer({ port: -1, ptyFactory: fakePtyFactory().factory, quiet: true })).rejects.toThrow();
    running.push(await startServer({ port: 0, ptyFactory: fakePtyFactory().factory, quiet: true }));
  });
});
