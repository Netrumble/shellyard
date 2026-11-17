import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClosedStore } from '../../src/server/closed.js';
import { defaultConfig, saveConfig } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import type { RestoreEntry } from '../../src/server/restore.js';
import { SessionManager } from '../../src/server/session-manager.js';
import type { ClosedSession, ServerMessage, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const node = process.execPath;
const CONV = '11111111-1111-4111-8111-111111111111';
const entry = (over: Partial<RestoreEntry> = {}): RestoreEntry => ({
  kind: 'shell', profileId: null, name: 'build', color: '#123456', cwd: 'C:\\work', command: 'pwsh', args: [], storyId: 'area-1', model: null, conversationId: null, ...over,
});

describe('ClosedStore', () => {
  const home = useTempHome();
  let now = 1000;
  const make = (): ClosedStore => new ClosedStore({ file: join(home.dir(), 'closed.json'), now: () => now });

  it('starts empty', () => {
    expect(make().list()).toEqual([]);
  });

  it('remembers a closed session, newest first, with when it was closed', () => {
    const store = make();
    const a = store.add(entry({ name: 'first' }), 'session-a');
    now = 2000;
    const b = store.add(entry({ name: 'second' }), 'session-b');
    expect(store.list().map((c) => [c.name, c.closedAt])).toEqual([['second', 2000], ['first', 1000]]);
    expect(a.id).not.toBe(b.id);
    expect(store.list()[1]).toMatchObject({ kind: 'shell', color: '#123456', cwd: 'C:\\work', storyId: 'area-1', sessionId: 'session-a', resumes: false });
  });

  it('says whether reopening will resume a conversation', () => {
    const store = make();
    expect(store.add(entry({ kind: 'claude', conversationId: CONV }), 's').resumes).toBe(true);
    expect(store.add(entry({ kind: 'claude', conversationId: null }), 's2').resumes).toBe(false);
  });

  it('keeps one entry per conversation: closing it again replaces the older one', () => {
    const store = make();
    store.add(entry({ kind: 'claude', conversationId: CONV, name: 'old name' }), 's1');
    now = 5000;
    store.add(entry({ kind: 'claude', conversationId: CONV, name: 'new name' }), 's2');
    expect(store.list().map((c) => c.name)).toEqual(['new name']);
  });

  it('hands an entry over once, to be reopened', () => {
    const store = make();
    const a = store.add(entry(), 's');
    expect(store.take(a.id)).toMatchObject({ name: 'build', command: 'pwsh' });
    expect(store.take(a.id)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('forgets an entry on request', () => {
    const store = make();
    const a = store.add(entry(), 's');
    expect(store.remove(a.id)).toBe(true);
    expect(store.remove(a.id)).toBe(false);
  });

  it('keeps only the most recent fifty', () => {
    const store = make();
    for (let i = 0; i < 60; i++) {
      now += 1;
      store.add(entry({ name: `s${i}` }), `id${i}`);
    }
    const list = store.list();
    expect(list).toHaveLength(50);
    expect(list[0]!.name).toBe('s59');
    expect(list[49]!.name).toBe('s10');
  });

  it('survives a restart, and a damaged file', () => {
    const store = make();
    store.add(entry({ name: 'kept' }), 's');
    expect(make().list().map((c) => c.name)).toEqual(['kept']);
    writeFileSync(join(home.dir(), 'closed.json'), '{ broken');
    expect(make().list()).toEqual([]);
    writeFileSync(join(home.dir(), 'closed.json'), JSON.stringify({ version: 1, closed: [{ id: 'x', name: 'ok', cwd: 'c', command: 'pwsh', closedAt: 5 }, 'junk', { id: 'y' }] }));
    expect(make().list().map((c) => c.name)).toEqual(['ok']);
  });

  it('announces every change', () => {
    const store = make();
    let changes = 0;
    store.onChange(() => changes++);
    const a = store.add(entry(), 's');
    store.take(a.id);
    store.remove('nope');
    expect(changes).toBe(2);
  });
});

describe('what the session manager reports as closed', () => {
  const home = useTempHome();
  let ptys: ReturnType<typeof fakePtyFactory>;
  let mgr: SessionManager;
  let closed: Array<{ entry: RestoreEntry; sessionId: string }>;

  beforeEach(() => {
    ptys = fakePtyFactory();
    closed = [];
    mgr = new SessionManager({ ptyFactory: ptys.factory, now: Date.now, config: defaultConfig, port: 1, hookToken: 'h', hookScriptPath: '/h.js', statusScriptPath: '/s.js', builtins: () => [] });
    mgr.onClosed((entry, sessionId) => closed.push({ entry, sessionId }));
  });
  const shell = (name: string): SessionInfo => mgr.create({ kind: 'shell', command: node, cwd: home.dir(), name });

  it('a session whose process ends', () => {
    const s = shell('build');
    ptys.last().exit(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ sessionId: s.id, entry: { name: 'build', kind: 'shell', cwd: home.dir(), command: node } });
  });

  it('a running session the user closes, once', () => {
    const s = shell('build');
    mgr.remove(s.id);
    expect(closed.map((c) => c.sessionId)).toEqual([s.id]);
  });

  it('not again when an ended session is then removed from the list', () => {
    const s = shell('build');
    ptys.last().exit(0);
    mgr.remove(s.id);
    expect(closed).toHaveLength(1);
  });

  it('not a session that never started', () => {
    mgr.create({ kind: 'shell', command: 'definitely-not-a-command', cwd: home.dir() });
    expect(closed).toEqual([]);
  });

  it('not the sessions ended by stopping the server: those come back by themselves', () => {
    shell('a');
    shell('b');
    mgr.shutdown();
    expect(closed).toEqual([]);
  });

  it('a Claude session with the conversation it was holding and the model it was started with', () => {
    const s = mgr.create({ kind: 'claude', command: node, cwd: home.dir(), model: 'opus' });
    mgr.setModel(s.id, 'Opus 4.1');
    mgr.setConversation(s.id, CONV);
    ptys.last().exit(0);
    expect(closed[0]!.entry).toMatchObject({ kind: 'claude', conversationId: CONV, model: 'opus' });
  });
});

describe('closed sessions over http, websocket and a restart', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  let ptys: ReturnType<typeof fakePtyFactory>;
  let work = '';

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
  }
  const start = async (): Promise<RunningServer> => {
    const s = await startServer({ port: await freePort(), ptyFactory: ptys.factory, quiet: true });
    running.push(s);
    return s;
  };
  const call = async (s: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: { 'x-cvm-token': s.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  function transcript(id: string, cwd: string): void {
    const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, cwd }) + '\n');
  }

  beforeEach(() => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    mkdirSync(work);
    saveConfig({ ...defaultConfig(), profiles: [{ id: 'builtin-claude', name: 'Claude Code', kind: 'claude', command: node, args: [], cwd: work, color: '#d97757', env: {}, model: null }] });
  });
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it('needs the token', async () => {
    const s = await start();
    expect((await fetch(`http://127.0.0.1:${s.port}/api/closed`)).status).toBe(401);
  });

  it('lists what was closed in an area, and reopens it there', async () => {
    const s = await start();
    const area = (await call(s, 'POST', '/api/stories', { name: 'Payroll' })).json;
    const shell = (await call(s, 'POST', '/api/sessions', { kind: 'shell', command: node, args: ['-i'], cwd: work, name: 'build', storyId: area.id, color: '#123456' })).json as SessionInfo;
    await call(s, 'DELETE', `/api/sessions/${shell.id}`);
    const list = (await call(s, 'GET', '/api/closed')).json as ClosedSession[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'build', kind: 'shell', storyId: area.id, cwd: work, resumes: false });

    const reopened = await call(s, 'POST', `/api/closed/${list[0]!.id}/reopen`);
    expect(reopened.status).toBe(201);
    expect(reopened.json).toMatchObject({ name: 'build', kind: 'shell', storyId: area.id, cwd: work, color: '#123456', args: ['-i'], status: 'running' });
    expect((await call(s, 'GET', '/api/closed')).json).toEqual([]);
    expect((await call(s, 'POST', `/api/closed/${list[0]!.id}/reopen`)).status).toBe(404);
  });

  it('reopens a session into another area, or into none, when asked', async () => {
    const s = await start();
    const a = (await call(s, 'POST', '/api/stories', { name: 'A' })).json;
    const b = (await call(s, 'POST', '/api/stories', { name: 'B' })).json;
    const close = async (name: string): Promise<string> => {
      const made = (await call(s, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name, storyId: a.id })).json as SessionInfo;
      await call(s, 'DELETE', `/api/sessions/${made.id}`);
      return ((await call(s, 'GET', '/api/closed')).json as ClosedSession[]).find((c) => c.name === name)!.id;
    };
    const moved = (await call(s, 'POST', `/api/closed/${await close('one')}/reopen`, { storyId: b.id })).json as SessionInfo;
    expect(moved.storyId).toBe(b.id);
    const loose = (await call(s, 'POST', `/api/closed/${await close('two')}/reopen`, { storyId: null })).json as SessionInfo;
    expect(loose.storyId).toBeNull();
    const same = (await call(s, 'POST', `/api/closed/${await close('three')}/reopen`, {})).json as SessionInfo;
    expect(same.storyId).toBe(a.id);
  });

  it('resumes a conversation straight into an area', async () => {
    const s = await start();
    const a = (await call(s, 'POST', '/api/stories', { name: 'A', cwd: home.dir() })).json;
    transcript(CONV, work);
    const resumed = (await call(s, 'POST', '/api/sessions', { resume: CONV, storyId: a.id })).json as SessionInfo;
    // In the area, but still in the folder the conversation was held in.
    expect(resumed).toMatchObject({ storyId: a.id, cwd: work, resumed: true });
  });

  it('reopens a Claude session on its conversation', async () => {
    const s = await start();
    const c = (await call(s, 'POST', '/api/sessions', { profileId: 'builtin-claude', name: 'backend', model: 'opus' })).json as SessionInfo;
    transcript(c.id, work);
    ptys.last().exit(0);
    const [closed] = (await call(s, 'GET', '/api/closed')).json as ClosedSession[];
    expect(closed).toMatchObject({ name: 'backend', kind: 'claude', resumes: true });
    const reopened = (await call(s, 'POST', `/api/closed/${closed!.id}/reopen`)).json as SessionInfo;
    expect(reopened).toMatchObject({ name: 'backend', resumed: true, status: 'idle' });
    const args = ptys.last().launch.args as string[];
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', c.id]);
    expect(args).toContain('opus');
    // The ended session it came from is cleared away, so it is not listed twice.
    expect(((await call(s, 'GET', '/api/sessions')).json as SessionInfo[]).map((x) => x.id)).toEqual([reopened.id]);
  });

  it('keeps the entry when reopening does not work, so that it can be tried again', async () => {
    const s = await start();
    const gone = join(home.dir(), 'gone');
    mkdirSync(gone);
    const shell = (await call(s, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: gone, name: 'lost' })).json as SessionInfo;
    await call(s, 'DELETE', `/api/sessions/${shell.id}`);
    const { rmSync } = await import('node:fs');
    rmSync(gone, { recursive: true });
    const [closed] = (await call(s, 'GET', '/api/closed')).json as ClosedSession[];
    const r = await call(s, 'POST', `/api/closed/${closed!.id}/reopen`);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/folder does not exist/i);
    expect((await call(s, 'GET', '/api/closed')).json).toHaveLength(1);
    expect((await call(s, 'GET', '/api/sessions')).json).toEqual([]);
  });

  it('forgets one on request', async () => {
    const s = await start();
    const shell = (await call(s, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'x' })).json as SessionInfo;
    await call(s, 'DELETE', `/api/sessions/${shell.id}`);
    const [closed] = (await call(s, 'GET', '/api/closed')).json as ClosedSession[];
    expect((await call(s, 'DELETE', `/api/closed/${closed!.id}`)).status).toBe(204);
    expect((await call(s, 'DELETE', `/api/closed/${closed!.id}`)).status).toBe(404);
    expect((await call(s, 'GET', '/api/closed')).json).toEqual([]);
  });

  it('pushes the list to the page on connect and on every change', async () => {
    const s = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['cvm', `cvm-token.${s.token}`], { headers: { origin: `http://127.0.0.1:${s.port}` } });
    const lists: string[][] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'closed') lists.push(m.closed.map((c) => c.name));
    });
    try {
      await waitUntil(() => lists.length === 1);
      const shell = (await call(s, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'pushed' })).json as SessionInfo;
      await call(s, 'DELETE', `/api/sessions/${shell.id}`);
      await waitUntil(() => lists.length === 2);
      expect(lists).toEqual([[], ['pushed']]);
    } finally {
      ws.terminate();
    }
  });

  it('remembers closed sessions across a restart, without bringing them back by themselves', async () => {
    const first = await start();
    const shell = (await call(first, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'closed before the stop' })).json as SessionInfo;
    await call(first, 'DELETE', `/api/sessions/${shell.id}`);
    await call(first, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'open at the stop' });
    await new Promise((r) => setTimeout(r, 400));
    await first.stop();
    running.length = 0;
    const second = await start();
    expect(((await call(second, 'GET', '/api/sessions')).json as SessionInfo[]).map((x) => x.name)).toEqual(['open at the stop']);
    expect(((await call(second, 'GET', '/api/closed')).json as ClosedSession[]).map((x) => x.name)).toEqual(['closed before the stop']);
    expect(JSON.parse(readFileSync(join(home.dir(), 'closed.json'), 'utf8')).closed).toHaveLength(1);
  });
});
