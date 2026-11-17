import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/server/config.js';
import { normalizeFont } from '../../src/server/fonts.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import type { ClosedSession, Profile, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const node = process.execPath;

describe('normalizeFont', () => {
  it('keeps a font name and a size', () => {
    expect(normalizeFont({ family: 'JetBrains Mono', size: 15 })).toEqual({ family: 'JetBrains Mono', size: 15 });
    expect(normalizeFont({ family: '  Consolas ', size: 14.4 })).toEqual({ family: 'Consolas', size: 14 });
  });
  it('keeps either one alone', () => {
    expect(normalizeFont({ family: 'Fira Code' })).toEqual({ family: 'Fira Code', size: null });
    expect(normalizeFont({ size: 18 })).toEqual({ family: null, size: 18 });
  });
  it('is nothing when neither is usable', () => {
    for (const v of [null, undefined, 'Consolas', 12, {}, { family: '', size: null }, { family: 'x; } body { display: none', size: 'big' }]) expect(normalizeFont(v), JSON.stringify(v)).toBeNull();
  });
  it('drops a name that is not a plain font name, and a size out of range', () => {
    expect(normalizeFont({ family: 'url(http://x)', size: 16 })).toEqual({ family: null, size: 16 });
    expect(normalizeFont({ family: '"Quoted"', size: 16 })).toEqual({ family: null, size: 16 });
    expect(normalizeFont({ family: 'A'.repeat(61), size: 16 })).toEqual({ family: null, size: 16 });
    expect(normalizeFont({ family: 'Consolas', size: 7 })).toEqual({ family: 'Consolas', size: null });
    expect(normalizeFont({ family: 'Consolas', size: 33 })).toEqual({ family: 'Consolas', size: null });
    expect(normalizeFont({ family: 'Consolas', size: Number.NaN })).toEqual({ family: 'Consolas', size: null });
  });
});

describe('fonts over http', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  let ptys: ReturnType<typeof fakePtyFactory>;
  let s: RunningServer;
  let work = '';

  async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise((r) => srv.close(r));
    return port;
  }
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { 'x-ttc-token': s.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const profile = (over: Partial<Profile> = {}): Profile => ({ id: 'mine', name: 'Mine', kind: 'shell', command: node, args: [], cwd: work, color: '#123456', env: {}, model: null, ...over });
  const boot = async (): Promise<void> => {
    s = await startServer({ port: await freePort(), ptyFactory: ptys.factory, quiet: true });
    running.push(s);
  };

  beforeEach(async () => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    mkdirSync(work);
    saveConfig(defaultConfig());
    await boot();
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
  });

  it('a session takes the font of its profile, unless the request gives another', async () => {
    await call('PUT', '/api/profiles', [profile({ font: { family: 'Fira Code', size: 16 } })]);
    expect(loadConfig().config.profiles[0]!.font).toEqual({ family: 'Fira Code', size: 16 });
    const a = (await call('POST', '/api/sessions', { profileId: 'mine' })).json as SessionInfo;
    expect(a.font).toEqual({ family: 'Fira Code', size: 16 });
    const b = (await call('POST', '/api/sessions', { profileId: 'mine', font: { size: 20 } })).json as SessionInfo;
    expect(b.font).toEqual({ family: null, size: 20 });
    const c = (await call('POST', '/api/sessions', { profileId: 'mine', font: null })).json as SessionInfo;
    expect(c.font).toBeNull();
    const d = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work })).json as SessionInfo;
    expect(d.font).toBeNull();
  });

  it('changes the font of a session that is already open, and clears it', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work })).json as SessionInfo;
    const set = (await call('PATCH', `/api/sessions/${made.id}`, { font: { family: 'Consolas', size: 18 } })).json as SessionInfo;
    expect(set.font).toEqual({ family: 'Consolas', size: 18 });
    const renamed = (await call('PATCH', `/api/sessions/${made.id}`, { name: 'other' })).json as SessionInfo;
    expect(renamed.font).toEqual({ family: 'Consolas', size: 18 });
    const cleared = (await call('PATCH', `/api/sessions/${made.id}`, { font: null })).json as SessionInfo;
    expect(cleared.font).toBeNull();
  });

  it('drops a font that is not valid from a saved profile', async () => {
    await call('PUT', '/api/profiles', [profile({ font: { family: 'x{}', size: 900 } as never })]);
    expect(loadConfig().config.profiles[0]!.font).toBeNull();
  });

  it('keeps the font of a session when it is closed and reopened, and across a restart', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'big', font: { size: 22 } })).json as SessionInfo;
    await call('DELETE', `/api/sessions/${made.id}`);
    const closed = (await call('GET', '/api/closed')).json as ClosedSession[];
    const reopened = (await call('POST', `/api/closed/${closed[0]!.id}/reopen`)).json as SessionInfo;
    expect(reopened.font).toEqual({ family: null, size: 22 });
    await s.stop();
    running.length = 0;
    await boot();
    const back = (await call('GET', '/api/sessions')).json as SessionInfo[];
    expect(back.map((x) => x.font)).toEqual([{ family: null, size: 22 }]);
  });
});
