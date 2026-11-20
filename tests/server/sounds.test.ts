import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { MAX_SOUND_BYTES, SoundStore, soundKind } from '../../src/server/sounds.js';
import { StoryStore } from '../../src/server/stories.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)]);
const MP3_SYNC = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('soundKind', () => {
  it('recognises mp3, wav and ogg by their bytes', () => {
    expect(soundKind(MP3_ID3)).toEqual({ ext: 'mp3', type: 'audio/mpeg' });
    expect(soundKind(MP3_SYNC)).toEqual({ ext: 'mp3', type: 'audio/mpeg' });
    expect(soundKind(WAV)).toEqual({ ext: 'wav', type: 'audio/wav' });
    expect(soundKind(OGG)).toEqual({ ext: 'ogg', type: 'audio/ogg' });
  });
  it('refuses anything else', () => {
    expect(soundKind(PNG)).toBeNull();
    expect(soundKind(Buffer.from('hello there, plain text'))).toBeNull();
    expect(soundKind(Buffer.alloc(0))).toBeNull();
  });
});

describe('SoundStore', () => {
  const home = useTempHome();
  let stories: StoryStore;
  let store: SoundStore;
  beforeEach(() => {
    stories = new StoryStore();
    store = new SoundStore(stories);
  });

  it('refuses bytes that are not mp3, wav or ogg', () => {
    expect(store.add(PNG, 'x')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('stores a sound under an id of its own, with a trimmed label of at most 80 characters, default "sound"', () => {
    const a = store.add(MP3_ID3, `  ${'n'.repeat(100)}  `)!;
    expect(a.id).toMatch(/^[0-9a-f-]{36}\.mp3$/);
    expect(a.name).toBe('n'.repeat(80));
    expect(store.add(WAV, '   ')!.name).toBe('sound');
    expect(readFileSync(join(home.dir(), 'sounds', a.id))).toEqual(MP3_ID3);
    expect(store.read(a.id)).toEqual({ bytes: MP3_ID3, type: 'audio/mpeg' });
    expect(store.list().map((s) => s.id)).toContain(a.id);
  });

  it('refuses a sound over the size limit', () => {
    expect(store.add(Buffer.concat([MP3_ID3, Buffer.alloc(MAX_SOUND_BYTES)]), 'big')).toBeNull();
  });

  it('settings with an unknown id become null', () => {
    const a = store.add(OGG, 'a')!;
    expect(store.setSettings({ blocked: a.id, finished: 'nope.mp3', maybeWaiting: 3 })).toEqual({ blocked: a.id, finished: null, maybeWaiting: null });
    expect(store.settings()).toEqual({ blocked: a.id, finished: null, maybeWaiting: null });
    expect(store.setSettings('junk')).toEqual({ blocked: null, finished: null, maybeWaiting: null });
  });

  it('deleting a sound clears the settings and areas that used it, and removes the file', () => {
    const a = store.add(OGG, 'a')!;
    const b = store.add(WAV, 'b')!;
    store.setSettings({ blocked: a.id, finished: b.id, maybeWaiting: a.id });
    const used = stories.create({ name: 'Used', sound: a.id });
    const other = stories.create({ name: 'Other', sound: b.id });
    expect(used.sound).toBe(a.id);
    const seen: string[][] = [];
    stories.onChange((list) => seen.push(list.map((s) => s.sound)));

    expect(store.remove(a.id)).toBe(true);
    expect(existsSync(join(home.dir(), 'sounds', a.id))).toBe(false);
    expect(store.list().map((s) => s.id)).toEqual([b.id]);
    expect(store.settings()).toEqual({ blocked: null, finished: b.id, maybeWaiting: null });
    expect(stories.list().find((s) => s.id === used.id)!.sound).toBe('');
    expect(stories.list().find((s) => s.id === other.id)!.sound).toBe(b.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(store.remove(a.id)).toBe(false);
  });

  it('keeps only known sounds in a story, on create, update and load', () => {
    const a = store.add(OGG, 'a')!;
    expect(stories.create({ name: 'A', sound: 'ghost.mp3' }).sound).toBe('');
    const s = stories.create({ name: 'B', sound: a.id });
    expect(stories.update(s.id, { sound: 'ghost.mp3' })!.sound).toBe('');
    expect(stories.update(s.id, { sound: a.id })!.sound).toBe(a.id);
    expect(stories.update(s.id, { name: 'C' })!.sound).toBe(a.id);
    const cfg = loadConfig().config;
    writeFileSync(join(home.dir(), 'config.json'), JSON.stringify({ ...cfg, stories: [{ ...cfg.stories[0], sound: 'ghost.mp3' }, { ...cfg.stories[1], sound: a.id }] }));
    expect(loadConfig().config.stories.map((x) => x.sound)).toEqual(['', a.id]);
  });
});

describe('sounds over http', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  let s: RunningServer;

  async function freePort(): Promise<number> {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    await new Promise((r) => srv.close(r));
    return port;
  }
  const url = (p: string): string => `http://127.0.0.1:${s.port}${p}`;
  const authed = (extra: Record<string, string> = {}): Record<string, string> => ({ 'x-shellyard-token': s.token, ...extra });
  const upload = (bytes: Buffer, name = 'ding', token = true): Promise<Response> =>
    fetch(url(`/api/sounds?name=${encodeURIComponent(name)}`), { method: 'POST', headers: token ? authed({ 'content-type': 'application/octet-stream' }) : {}, body: new Uint8Array(bytes) });

  beforeEach(async () => {
    saveConfig(defaultConfig());
    s = await startServer({ port: await freePort(), ptyFactory: fakePtyFactory().factory, quiet: true });
    running.push(s);
  });
  afterEach(async () => {
    for (const r of running.splice(0)) await r.stop();
  });

  it('uploads, lists, serves with its content type, and deletes', async () => {
    const res = await upload(MP3_ID3, ' ding ');
    expect(res.status).toBe(201);
    const file = (await res.json()) as { id: string; name: string };
    expect(file.name).toBe('ding');
    const list = await (await fetch(url('/api/sounds'), { headers: authed() })).json();
    expect(list).toEqual({ sounds: [file], settings: { blocked: null, finished: null, maybeWaiting: null } });
    const got = await fetch(url(`/api/sounds/${file.id}`), { headers: authed() });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(MP3_ID3);
    expect((await fetch(url(`/api/sounds/${file.id}`), { method: 'DELETE', headers: authed() })).status).toBe(204);
    expect((await fetch(url(`/api/sounds/${file.id}`), { method: 'DELETE', headers: authed() })).status).toBe(404);
    expect((await fetch(url(`/api/sounds/${file.id}`), { headers: authed() })).status).toBe(404);
  });

  it('refuses what is not audio (400) and what is too large (413)', async () => {
    expect((await upload(PNG)).status).toBe(400);
    expect((await upload(Buffer.concat([MP3_ID3, Buffer.alloc(MAX_SOUND_BYTES + 10)])).catch(() => ({ status: 413 }))).status).toBe(413);
  });

  it('needs the token on every route', async () => {
    const file = (await (await upload(OGG)).json()) as { id: string };
    expect((await upload(OGG, 'x', false)).status).toBe(401);
    expect((await fetch(url('/api/sounds'))).status).toBe(401);
    expect((await fetch(url(`/api/sounds/${file.id}`))).status).toBe(401);
    expect((await fetch(url(`/api/sounds/${file.id}`), { method: 'DELETE' })).status).toBe(401);
    expect((await fetch(url('/api/sounds/settings'), { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  it('serves only ids of its own shape', async () => {
    writeFileSync(join(home.dir(), 'secret.mp3'), MP3_ID3);
    for (const name of ['..%2Fsecret.mp3', 'secret.mp3', 'server.json', 'x.exe', `${'a'.repeat(36)}.png`, 'settings.mp3']) {
      const res = await fetch(url(`/api/sounds/${name}`), { headers: authed() });
      expect([400, 404], name).toContain(res.status);
    }
  });

  it('settings are saved, and unknown ids become null', async () => {
    const file = (await (await upload(WAV)).json()) as { id: string };
    const put = await fetch(url('/api/sounds/settings'), { method: 'PUT', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ blocked: file.id, finished: 'ghost.mp3', maybeWaiting: null }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ blocked: file.id, finished: null, maybeWaiting: null });
    expect(loadConfig().config.sounds).toEqual({ blocked: file.id, finished: null, maybeWaiting: null });
  });

  it('an area can carry a sound through the stories api', async () => {
    const file = (await (await upload(WAV)).json()) as { id: string };
    const created = await fetch(url('/api/stories'), { method: 'POST', headers: authed({ 'content-type': 'application/json' }), body: JSON.stringify({ name: 'A', sound: file.id }) });
    expect(((await created.json()) as { sound: string }).sound).toBe(file.id);
  });
});
