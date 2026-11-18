import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageKind, normalizeBackground } from '../../src/server/backgrounds.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import type { Profile, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const node = process.execPath;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);

describe('normalizeBackground', () => {
  it('accepts a colour', () => {
    expect(normalizeBackground({ color: '#1A2b3C' })).toEqual({ color: '#1a2b3c', image: null, veil: 0.55 });
  });
  it('accepts an uploaded image with its veil, kept within limits', () => {
    expect(normalizeBackground({ image: 'abc-123.png', veil: 0.3 })).toEqual({ color: null, image: 'abc-123.png', veil: 0.3 });
    expect(normalizeBackground({ image: 'abc-123.png', veil: 7 })!.veil).toBe(0.95);
    expect(normalizeBackground({ image: 'abc-123.png', veil: -1 })!.veil).toBe(0);
    expect(normalizeBackground({ image: 'abc-123.png', veil: 'dark' })!.veil).toBe(0.55);
  });
  it('is nothing when neither a colour nor an image is given', () => {
    expect(normalizeBackground(null)).toBeNull();
    expect(normalizeBackground({})).toBeNull();
    expect(normalizeBackground({ color: null, image: null, veil: 0.2 })).toBeNull();
    expect(normalizeBackground('red')).toBeNull();
  });
  it('refuses anything that is not a colour or one of its own image names', () => {
    expect(normalizeBackground({ color: 'url(http://evil)' })).toBeNull();
    expect(normalizeBackground({ color: 'red' })).toBeNull();
    expect(normalizeBackground({ image: '../../secret.png' })).toBeNull();
    expect(normalizeBackground({ image: 'http://evil/x.png' })).toBeNull();
    expect(normalizeBackground({ image: 'a.svg' })).toBeNull();
    expect(normalizeBackground({ image: 'a.png', color: 'nope' })).toEqual({ color: null, image: 'a.png', veil: 0.55 });
  });
});

describe('imageKind', () => {
  it('recognises images by their first bytes, whatever they are called', () => {
    expect(imageKind(PNG)).toEqual({ ext: 'png', type: 'image/png' });
    expect(imageKind(JPEG)).toEqual({ ext: 'jpg', type: 'image/jpeg' });
    expect(imageKind(WEBP)).toEqual({ ext: 'webp', type: 'image/webp' });
  });
  it('refuses what is not an image', () => {
    expect(imageKind(Buffer.from('<svg onload="alert(1)">'))).toBeNull();
    expect(imageKind(Buffer.from('<html>'))).toBeNull();
    expect(imageKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('backgrounds over http', () => {
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
  const url = (p: string): string => `http://127.0.0.1:${s.port}${p}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(url(path), { method, headers: { 'x-shellyard-token': s.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const upload = (bytes: Buffer, token = true): Promise<Response> =>
    fetch(url('/api/backgrounds'), { method: 'POST', headers: { ...(token ? { 'x-shellyard-token': s.token } : {}), 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  const profile = (over: Partial<Profile> = {}): Profile => ({ id: 'mine', name: 'Mine', kind: 'shell', command: node, args: [], cwd: work, color: '#123456', env: {}, model: null, ...over });

  beforeEach(async () => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    mkdirSync(work);
    saveConfig(defaultConfig());
    s = await startServer({ port: await freePort(), ptyFactory: ptys.factory, quiet: true });
    running.push(s);
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
  });

  it('stores an uploaded image under a name of its own and serves it back, to the page only', async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(201);
    const { image } = (await res.json()) as { image: string };
    expect(image).toMatch(/^[0-9a-f-]+\.png$/);
    expect(readFileSync(join(home.dir(), 'backgrounds', image))).toEqual(PNG);

    expect((await fetch(url(`/api/backgrounds/${image}`))).status).toBe(401);
    const got = await fetch(url(`/api/backgrounds/${image}`), { headers: { 'x-shellyard-token': s.token } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  it('refuses an upload without the token, one that is not an image, and one that is too large', async () => {
    expect((await upload(PNG, false)).status).toBe(401);
    expect((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).status).toBe(400);
    expect((await upload(Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)])).catch(() => ({ status: 413 }))).status).toBe(413);
    expect(existsSync(join(home.dir(), 'backgrounds')) ? require('node:fs').readdirSync(join(home.dir(), 'backgrounds')) : []).toEqual([]);
  });

  it('serves only its own images', async () => {
    writeFileSync(join(home.dir(), 'secret.png'), PNG);
    for (const name of ['..%2Fsecret.png', '%2e%2e%2fsecret.png', 'nope.png', 'server.json', 'x.svg']) {
      const res = await fetch(url(`/api/backgrounds/${name}`), { headers: { 'x-shellyard-token': s.token } });
      expect([400, 404], name).toContain(res.status);
    }
  });

  it('a session takes the background of its profile, unless the request gives another', async () => {
    const { image } = (await (await upload(JPEG)).json()) as { image: string };
    await call('PUT', '/api/profiles', [profile({ background: { color: null, image, veil: 0.4 } })]);
    expect(loadConfig().config.profiles[0]!.background).toEqual({ color: null, image, veil: 0.4 });
    const a = (await call('POST', '/api/sessions', { profileId: 'mine' })).json as SessionInfo;
    expect(a.background).toEqual({ color: null, image, veil: 0.4 });
    const b = (await call('POST', '/api/sessions', { profileId: 'mine', background: { color: '#202020' } })).json as SessionInfo;
    expect(b.background).toEqual({ color: '#202020', image: null, veil: 0.55 });
    const c = (await call('POST', '/api/sessions', { profileId: 'mine', background: null })).json as SessionInfo;
    expect(c.background).toBeNull();
    const d = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work })).json as SessionInfo;
    expect(d.background).toBeNull();
  });

  it('changes the background of a session that is already open, and clears it', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work })).json as SessionInfo;
    const set = (await call('PATCH', `/api/sessions/${made.id}`, { background: { color: '#0a0a0a' } })).json as SessionInfo;
    expect(set.background).toEqual({ color: '#0a0a0a', image: null, veil: 0.55 });
    expect(ptys.last().killed).toBe(false);
    const renamed = (await call('PATCH', `/api/sessions/${made.id}`, { name: 'x' })).json as SessionInfo;
    expect(renamed.background).toEqual({ color: '#0a0a0a', image: null, veil: 0.55 });
    const cleared = (await call('PATCH', `/api/sessions/${made.id}`, { background: null })).json as SessionInfo;
    expect(cleared.background).toBeNull();
    const bad = (await call('PATCH', `/api/sessions/${made.id}`, { background: { color: 'url(x)' } })).json as SessionInfo;
    expect(bad.background).toBeNull();
  });

  it('drops a background that is not valid from a saved profile', async () => {
    await call('PUT', '/api/profiles', [profile({ background: { color: 'javascript:1', image: '../x.png', veil: 2 } as never })]);
    expect(loadConfig().config.profiles[0]!.background).toBeNull();
  });

  it('keeps the background of a session when it is closed and reopened, and across a restart', async () => {
    const made = (await call('POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'painted', background: { color: '#112233' } })).json as SessionInfo;
    await call('DELETE', `/api/sessions/${made.id}`);
    const [closed] = (await call('GET', '/api/closed')).json as Array<{ id: string }>;
    const reopened = (await call('POST', `/api/closed/${closed!.id}/reopen`)).json as SessionInfo;
    expect(reopened.background).toEqual({ color: '#112233', image: null, veil: 0.55 });
    await new Promise((r) => setTimeout(r, 400));
    await s.stop();
    running.length = 0;
    s = await startServer({ port: await freePort(), ptyFactory: ptys.factory, quiet: true });
    running.push(s);
    const back = (await call('GET', '/api/sessions')).json as SessionInfo[];
    expect(back.find((x) => x.name === 'painted')!.background).toEqual({ color: '#112233', image: null, veil: 0.55 });
  });
});
