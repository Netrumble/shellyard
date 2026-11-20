import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import type { SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const node = process.execPath;

describe('opening the editor on a session, over http', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  let s: RunningServer;
  let work = '';
  let opened: Array<{ command: string; args: string[]; cwd: string }> = [];
  let answer: string | null = null;

  async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise((r) => srv.close(r));
    return port;
  }
  const call = async (method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { ...(auth ? { 'x-shellyard-token': s.token } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    opened = [];
    answer = null;
    work = join(home.dir(), 'work');
    mkdirSync(work);
    saveConfig(defaultConfig());
    s = await startServer({
      port: await freePort(),
      ptyFactory: fakePtyFactory().factory,
      quiet: true,
      openEditor: (session) => {
        opened.push(session);
        return answer;
      },
    });
    running.push(s);
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
  });

  it('opens the editor on the folder the session was started in', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, args: ['-i'], cwd: work })).json as SessionInfo;
    expect((await call('POST', `/api/sessions/${made.id}/editor`)).status).toBe(204);
    expect(opened).toEqual([{ command: node, args: ['-i'], cwd: work }]);
  });

  it('answers with the reason when the editor cannot be opened', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work })).json as SessionInfo;
    answer = 'VS Code was not found on this computer (the "code" command is not on the PATH).';
    const res = await call('POST', `/api/sessions/${made.id}/editor`);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(answer);
  });

  it('needs the token, a session that exists, and POST', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work })).json as SessionInfo;
    expect((await call('POST', `/api/sessions/${made.id}/editor`, undefined, false)).status).toBe(401);
    expect((await call('POST', '/api/sessions/nope/editor')).status).toBe(404);
    expect((await call('GET', `/api/sessions/${made.id}/editor`)).status).toBe(405);
    expect(opened).toEqual([]);
  });
});

describe('opening the editor on an area, over http', () => {
  const home = useTempHome();
  let s: RunningServer;
  let opened: Array<{ command: string; args: string[]; cwd: string }> = [];

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { 'x-shellyard-token': s.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    opened = [];
    saveConfig(defaultConfig());
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    s = await startServer({
      port,
      ptyFactory: fakePtyFactory().factory,
      quiet: true,
      openEditor: (target) => {
        opened.push(target);
        return null;
      },
    });
  });
  afterEach(async () => {
    await s.stop();
  });

  it("opens the area's own folder, and says so when the area has none", async () => {
    const work = join(home.dir(), 'area');
    mkdirSync(work);
    const withFolder = (await call('POST', '/api/stories', { name: 'Payroll', cwd: work })).json;
    const without = (await call('POST', '/api/stories', { name: 'Loose' })).json;
    expect((await call('POST', `/api/stories/${withFolder.id}/editor`)).status).toBe(204);
    expect(opened).toEqual([{ command: '', args: [], cwd: work }]);
    expect((await call('POST', `/api/stories/${without.id}/editor`)).status).toBe(409);
    expect((await call('POST', '/api/stories/nope/editor')).status).toBe(404);
    expect((await call('GET', `/api/stories/${withFolder.id}/editor`)).status).toBe(405);
    expect(opened).toHaveLength(1);
  });
});
