import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { acquireInstanceLock, lockAddress, type InstanceLock } from '../../src/server/instance-lock.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

describe('lockAddress', () => {
  it('is a named pipe on Windows, the same for the same folder whatever its case', () => {
    const a = lockAddress('C:\\Users\\me\\.shellyard', 'win32');
    expect(a).toMatch(/^\\\\\.\\pipe\\shellyard-[0-9a-f]{32}$/);
    expect(lockAddress('c:\\users\\ME\\.shellyard', 'win32')).toBe(a);
    expect(lockAddress('C:\\Users\\other\\.shellyard', 'win32')).not.toBe(a);
  });

  it('is a socket file in the folder elsewhere', () => {
    expect(lockAddress('/home/me/.shellyard', 'linux')).toBe('/home/me/.shellyard/server.lock');
  });
});

describe('acquireInstanceLock', () => {
  const home = useTempHome();
  const held: InstanceLock[] = [];
  afterEach(async () => {
    for (const l of held.splice(0)) await l.release();
  });

  it('gives a folder to one holder at a time', async () => {
    const first = await acquireInstanceLock(home.dir());
    expect(first).not.toBeNull();
    held.push(first!);
    expect(await acquireInstanceLock(home.dir())).toBeNull();
    await first!.release();
    held.splice(0);
    const again = await acquireInstanceLock(home.dir());
    expect(again).not.toBeNull();
    held.push(again!);
  });

  it('gives one of several starts racing each other the folder', async () => {
    const all = await Promise.all([1, 2, 3, 4].map(() => acquireInstanceLock(home.dir())));
    const got = all.filter((l): l is InstanceLock => l !== null);
    held.push(...got);
    expect(got).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('takes over the socket file of a server that was killed', async () => {
    writeFileSync(lockAddress(home.dir()), '');
    const lock = await acquireInstanceLock(home.dir());
    expect(lock).not.toBeNull();
    held.push(lock!);
  });
});

describe('startServer on a folder already in use', () => {
  useTempHome();
  const running: RunningServer[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it('refuses to start, so the sessions are not restored twice', async () => {
    const opts = { port: 0, ptyFactory: fakePtyFactory().factory, quiet: true };
    const results = await Promise.allSettled([startServer(opts), startServer(opts)]);
    for (const r of results) if (r.status === 'fulfilled') running.push(r.value);
    expect(running).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(String((refused as PromiseRejectedResult).reason)).toMatch(/already running/);
    // Once stopped, the folder is free for the next start.
    await running.splice(0)[0]!.stop();
    running.push(await startServer(opts));
  });
});
