import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readServerState } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe('startServer', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  const start = async (port: number): Promise<RunningServer> => {
    const s = await startServer({ port, ptyFactory: fakePtyFactory().factory, quiet: true });
    running.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it('writes its state file, answers health, and cleans up on stop', async () => {
    const port = await freePort();
    const s = await start(port);
    expect(s.port).toBe(port);
    const state = readServerState();
    expect(state).toMatchObject({ pid: process.pid, port, token: s.token });
    expect(state!.hookToken).toMatch(/^[0-9a-f]{64}$/);
    expect(state!.hookToken).not.toBe(state!.token);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const pkgVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    expect(await res.json()).toEqual({ ok: true, app: 'shellyard', startedAt: state!.startedAt, version: pkgVersion });

    await s.stop();
    running.length = 0;
    expect(readServerState()).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });

  it('listens on loopback only', async () => {
    const s = await start(await freePort());
    expect(s.address).toBe('127.0.0.1');
  });

  it('moves to another port when the requested one is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const s = await start(taken);
      expect(s.port).not.toBe(taken);
      expect(s.port).toBeGreaterThan(taken);
      expect(s.port).toBeLessThanOrEqual(taken + 50);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('on stop, leaves alone a state file that belongs to another server', async () => {
    const s = await start(await freePort());
    const other = { pid: 4242, port: 1, token: 'x', hookToken: 'y', startedAt: 1 };
    writeFileSync(join(home.dir(), 'server.json'), JSON.stringify(other));
    await s.stop();
    running.length = 0;
    expect(readServerState()).toEqual(other);
  });

  it('starts with defaults when config.json is corrupt', async () => {
    writeFileSync(join(home.dir(), 'config.json'), '{broken');
    const s = await start(await freePort());
    const res = await fetch(`http://127.0.0.1:${s.port}/api/meta`, { headers: { 'x-shellyard-token': s.token } });
    expect((await res.json()).models).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('applies hook events end to end with the hook token from the state file', async () => {
    const s = await start(await freePort());
    const headers = { 'x-shellyard-token': s.token, 'content-type': 'application/json' };
    const created = await fetch(`http://127.0.0.1:${s.port}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'claude', command: process.execPath, cwd: home.dir() }),
    });
    const session = await created.json();
    const hook = await fetch(`http://127.0.0.1:${s.port}/api/hooks/${session.id}`, {
      method: 'POST',
      headers: { 'x-shellyard-hook-token': readServerState()!.hookToken },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    });
    expect(hook.status).toBe(204);
    const list = await (await fetch(`http://127.0.0.1:${s.port}/api/sessions`, { headers })).json();
    expect(list[0]).toMatchObject({ status: 'attention', reason: 'finished' });
  });
});

