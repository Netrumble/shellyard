import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultConfig } from '../../src/server/config.js';
import { join } from 'node:path';
import { ActivityMeter } from '../../src/server/activity.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { UsageStore } from '../../src/server/usage.js';
import { attachWebSocket } from '../../src/server/ws.js';
import type { ServerMessage, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const TOKEN = 't'.repeat(64);

class Client {
  messages: ServerMessage[] = [];
  closed = false;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.messages.push(JSON.parse(String(d))));
    ws.on('close', () => (this.closed = true));
  }
  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  of<T extends ServerMessage['t']>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  forSession(id: string): ServerMessage[] {
    return this.messages.filter((m) => (m.t === 'snapshot' || m.t === 'output') && m.id === id);
  }
}

describe('websocket', () => {
  const home = useTempHome();
  let server: Server;
  let port = 0;
  let mgr: SessionManager;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let handle: { close(): void };
  let usage: UsageStore;
  let activity: ActivityMeter;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ptys = fakePtyFactory();
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    mgr = new SessionManager({ ptyFactory: ptys.factory, now: Date.now, config: defaultConfig, port, hookToken: 'h', hookScriptPath: '/h.js', statusScriptPath: '/s.js', builtins: () => [] });
    usage = new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') });
    activity = new ActivityMeter(Date.now);
    mgr.onOutput((id, data) => activity.add(id, data.length));
    handle = attachWebSocket(server, { manager: mgr, usage, activity, port, token: TOKEN });
  });

  afterEach(async () => {
    for (const s of sockets) s.terminate();
    sockets.length = 0;
    handle.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  function open(headers: Record<string, string>, path = '/ws', protocols: string[] = ['cvm', `cvm-token.${TOKEN}`]): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers });
      sockets.push(ws);
      const client = new Client(ws);
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
      ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    });
  }
  const good = (): Record<string, string> => ({ origin: `http://127.0.0.1:${port}` });
  const connect = (): Promise<Client> => open(good());
  const shell = (): SessionInfo => mgr.create({ kind: 'shell', command: process.execPath, cwd: home.dir() });

  describe('upgrade checks', () => {
    it('accepts the token offered in the subprotocol list and settles on the cvm protocol', async () => {
      const c = await connect();
      expect(c.ws.protocol).toBe('cvm');
    });
    it('refuses a connection that offers no token', async () => {
      await expect(open(good(), '/ws', ['cvm'])).rejects.toThrow(/refused 401/);
      await expect(open(good(), '/ws', [])).rejects.toThrow(/refused 401/);
    });
    it('refuses a wrong token', async () => {
      await expect(open(good(), '/ws', ['cvm', 'cvm-token.' + 'b'.repeat(64)])).rejects.toThrow(/refused 401/);
    });
    it('refuses a cookie in place of the token', async () => {
      await expect(open({ ...good(), cookie: `cvm_auth=${TOKEN}` }, '/ws', ['cvm'])).rejects.toThrow(/refused 401/);
    });
    it('refuses a foreign origin that offers the protocol name but no token', async () => {
      await expect(open({ origin: 'http://evil.com' }, '/ws', ['cvm'])).rejects.toThrow(/refused 403/);
    });
    it('refuses a foreign origin even with the token', async () => {
      await expect(open({ origin: 'http://evil.com' })).rejects.toThrow(/refused 403/);
    });
    it('refuses a connection with no origin', async () => {
      await expect(open({})).rejects.toThrow(/refused 403/);
    });
    it('refuses a foreign host header', async () => {
      await expect(open({ ...good(), host: 'evil.com' })).rejects.toThrow(/refused 403/);
    });
    it('refuses another path', async () => {
      await expect(open(good(), '/other')).rejects.toThrow(/refused 404/);
    });
  });

  it('sends the session list first', async () => {
    const s = shell();
    const c = await connect();
    await waitUntil(() => c.messages.length > 0);
    expect(c.messages[0]).toEqual({ t: 'sessions', sessions: [mgr.get(s.id)] });
  });

  it('answers attach with a snapshot of earlier output, then streams in order', async () => {
    const s = shell();
    const pty = ptys.last();
    pty.emit('earlier-output');
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 90, rows: 25 });
    await waitUntil(() => c.of('snapshot').length === 1);
    expect(c.forSession(s.id)[0]).toMatchObject({ t: 'snapshot', id: s.id });
    expect(c.of('snapshot')[0]!.data).toContain('earlier-output');
    expect(pty.resizes).toEqual([[90, 25]]);
    pty.emit('one');
    pty.emit('two');
    pty.emit('three');
    await waitUntil(() => c.of('output').length === 3);
    expect(c.of('output').map((m) => m.data)).toEqual(['one', 'two', 'three']);
  });

  it('does not lose or reorder output produced while the snapshot is being taken', async () => {
    const s = shell();
    const pty = ptys.last();
    pty.emit('before;');
    // Hold the snapshot back so that output really arrives while it is being taken.
    const realSnapshot = mgr.snapshot.bind(mgr);
    let asked = false;
    mgr.snapshot = async (id: string) => {
      const taken = realSnapshot(id);
      asked = true;
      await new Promise((r) => setTimeout(r, 150));
      return taken;
    };
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => asked);
    pty.emit('during;');
    expect(c.forSession(s.id)).toEqual([]);
    await waitUntil(() => c.of('output').length === 1);
    const msgs = c.forSession(s.id);
    expect(msgs[0]!.t).toBe('snapshot');
    const all = msgs.map((m) => (m.t === 'snapshot' || m.t === 'output' ? m.data : '')).join('');
    expect(all.indexOf('before;')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('during;')).toBeGreaterThan(all.indexOf('before;'));
    expect(all.split('during;').length - 1).toBe(1);
  });

  it('does not send output for sessions a client has not attached to', async () => {
    const a = shell();
    const pa = ptys.last();
    const b = shell();
    const pb = ptys.last();
    const c = await connect();
    c.send({ t: 'attach', id: a.id, cols: 80, rows: 24 });
    await waitUntil(() => c.of('snapshot').length === 1);
    pb.emit('other');
    pa.emit('mine');
    await waitUntil(() => c.of('output').length === 1);
    expect(c.of('output')).toEqual([{ t: 'output', id: a.id, data: 'mine' }]);
    expect(c.forSession(b.id)).toEqual([]);
  });

  it('serves two clients on one session, and one leaving does not affect the other', async () => {
    const s = shell();
    const pty = ptys.last();
    const c1 = await connect();
    const c2 = await connect();
    for (const c of [c1, c2]) c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => c1.of('snapshot').length === 1 && c2.of('snapshot').length === 1);
    pty.emit('both');
    await waitUntil(() => c1.of('output').length === 1 && c2.of('output').length === 1);
    c1.ws.close();
    await waitUntil(() => c1.closed);
    pty.emit('second-only');
    await waitUntil(() => c2.of('output').length === 2);
    expect(c2.of('output')[1]!.data).toBe('second-only');
    expect(mgr.get(s.id)!.status).toBe('running');
    expect(pty.killed).toBe(false);
  });

  it('stops streaming after detach', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => c.of('snapshot').length === 1);
    c.send({ t: 'detach', id: s.id });
    c.send({ t: 'input', id: s.id, data: 'x' });
    await waitUntil(() => pty.written.length === 1);
    pty.emit('after-detach');
    await new Promise((r) => setTimeout(r, 100));
    expect(c.of('output')).toEqual([]);
  });

  it('a second attach from the same client does not double the output', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    c.send({ t: 'attach', id: s.id, cols: 80, rows: 24 });
    await waitUntil(() => c.of('snapshot').length >= 1);
    pty.emit('once');
    await new Promise((r) => setTimeout(r, 100));
    // The second attach replaces the first: one snapshot, one copy of each later chunk.
    expect(c.of('snapshot')).toHaveLength(1);
    expect(c.of('output').map((m) => m.data)).toEqual(['once']);
  });

  it('passes input and resize to the session, ignoring a degenerate size', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send({ t: 'input', id: s.id, data: 'ls\r' });
    c.send({ t: 'resize', id: s.id, cols: 0, rows: 24 });
    c.send({ t: 'resize', id: s.id, cols: 100, rows: 40 });
    await waitUntil(() => pty.resizes.length === 1 && pty.written.length === 1);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.resizes).toEqual([[100, 40]]);
  });

  it('survives garbage, unknown message types, wrong field types and unknown sessions', async () => {
    const s = shell();
    const pty = ptys.last();
    const c = await connect();
    c.send('not json');
    c.send({ t: 'explode' });
    c.send({ t: 'attach', id: 'nope', cols: 80, rows: 24 });
    c.send({ t: 'input', id: s.id, data: 42 });
    c.send({ t: 'input', id: 'nope', data: 'x' });
    c.send({ t: 'resize', id: s.id, cols: 'wide', rows: null });
    c.send('null');
    c.send({ t: 'input', id: s.id, data: 'still-alive' });
    await waitUntil(() => pty.written.length === 1);
    expect(pty.written).toEqual(['still-alive']);
    expect(c.closed).toBe(false);
    expect(pty.resizes).toEqual([]);
  });

  it('sends the usage summary on connect and again after it changes', async () => {
    const c = await connect();
    await waitUntil(() => c.of('usage').length === 1);
    expect(c.of('usage')[0]!.usage.today.costUsd).toBe(0);
    usage.record('s1', { modelId: 'm', modelName: 'M', costUsd: 2, tokensIn: 1, tokensOut: 1, fiveHour: null, sevenDay: null }, { storyId: null, storyName: null });
    await waitUntil(() => c.of('usage').length === 2, 4000);
    expect(c.of('usage')[1]!.usage.today.costUsd).toBeCloseTo(2);
  });

  it('reports how much sessions are printing, then that they went quiet', async () => {
    const s = shell();
    const c = await connect();
    ptys.last().emit('x'.repeat(500));
    await waitUntil(() => c.of('activity').length >= 1, 4000);
    expect(c.of('activity')[0]!.rates[s.id]).toBe(500);
    await waitUntil(() => c.of('activity').some((m) => Object.keys(m.rates).length === 0), 5000);
    const after = c.of('activity').length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(c.of('activity').length).toBe(after);
  });

  it('broadcasts status changes to every client', async () => {
    const s = mgr.create({ kind: 'claude', command: process.execPath, cwd: home.dir() });
    const c1 = await connect();
    const c2 = await connect();
    await waitUntil(() => c1.of('sessions').length === 1 && c2.of('sessions').length === 1);
    mgr.hook(s.id, 'UserPromptSubmit', false);
    await waitUntil(() => c1.of('sessions').length === 2 && c2.of('sessions').length === 2);
    expect(c1.of('sessions')[1]!.sessions[0]!.status).toBe('working');
    expect(c2.of('sessions')[1]!.sessions[0]!.status).toBe('working');
  });
});
