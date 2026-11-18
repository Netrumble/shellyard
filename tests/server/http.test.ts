import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { createRequestHandler } from '../../src/server/http.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { StoryStore } from '../../src/server/stories.js';
import { ClosedStore } from '../../src/server/closed.js';
import { UsageStore } from '../../src/server/usage.js';
import type { Profile } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const TOKEN = 't'.repeat(64);
const HOOK_TOKEN = 'h'.repeat(64);
const builtin: Profile = { id: 'builtin-node', name: 'Node', kind: 'shell', command: process.execPath, args: [], cwd: '', color: '#123456', env: {}, model: null };

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => any;
}

describe('http api', () => {
  const home = useTempHome();
  let server: Server;
  let port = 0;
  let mgr: SessionManager;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let shutdowns = 0;
  let webDir = '';
  let stories: StoryStore;

  /** Raw request so the Host header and the path can be anything. */
  function call(method: string, path: string, opts: { body?: string; headers?: Record<string, string>; auth?: 'user' | 'none' | 'hook' } = {}): Promise<Res> {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers };
    const auth = opts.auth ?? 'user';
    if (auth === 'user') headers['x-shellyard-token'] = TOKEN;
    if (auth === 'hook') headers['x-shellyard-hook-token'] = HOOK_TOKEN;
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  beforeEach(async () => {
    shutdowns = 0;
    ptys = fakePtyFactory();
    webDir = join(home.dir(), 'web');
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<html>ShellYard APP</html>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(home.dir(), 'secret.txt'), 'TOP SECRET');
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    stories = new StoryStore();
    mgr = new SessionManager({
      stories: () => stories.list(),
      ptyFactory: ptys.factory,
      now: Date.now,
      config: () => loadConfig().config,
      port,
      hookToken: HOOK_TOKEN,
      hookScriptPath: '/h.js', statusScriptPath: '/s.js',
      builtins: () => [builtin],
    });
    server.on('request', createRequestHandler({ manager: mgr, stories, usage: new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') }), closed: new ClosedStore({ now: Date.now, file: join(home.dir(), 'closed.json') }), port, token: TOKEN, hookToken: HOOK_TOKEN, webDir, startedAt: 777, onShutdown: () => shutdowns++ }));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  const newSession = async (kind: 'shell' | 'claude' = 'shell') =>
    (await call('POST', '/api/sessions', { body: JSON.stringify({ kind, command: process.execPath, cwd: home.dir() }) })).json();

  describe('gatekeeping', () => {
    it('rejects a foreign Host header', async () => {
      const r = await call('GET', '/api/health', { headers: { host: 'evil.com' } });
      expect(r.status).toBe(403);
    });

    it('answers health without credentials', async () => {
      const r = await call('GET', '/api/health', { auth: 'none' });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual({ ok: true, app: 'shellyard', startedAt: 777 });
    });

    it('refuses the api without credentials', async () => {
      expect((await call('GET', '/api/sessions', { auth: 'none' })).status).toBe(401);
      expect((await call('POST', '/api/sessions', { auth: 'none', body: '{}' })).status).toBe(401);
      expect((await call('POST', '/api/shutdown', { auth: 'none' })).status).toBe(401);
      expect(shutdowns).toBe(0);
    });

    it('serves the app itself without credentials: it holds no secret, the api does', async () => {
      const page = await call('GET', '/', { auth: 'none' });
      expect(page.status).toBe(200);
      expect(page.text).toContain('ShellYard APP');
      expect((await call('GET', '/assets/app.js', { auth: 'none' })).status).toBe(200);
    });

    it('does not accept the hook token as a user token', async () => {
      const r = await call('GET', '/api/sessions', { auth: 'none', headers: { 'x-shellyard-token': HOOK_TOKEN } });
      expect(r.status).toBe(401);
    });

    it('never sets a cookie, whatever the request', async () => {
      // A cookie for 127.0.0.1 would be sent by the browser to every other port on this machine.
      for (const r of [
        await call('GET', `/?token=${TOKEN}`, { auth: 'none' }),
        await call('GET', '/'),
        await call('GET', '/api/sessions'),
        await call('GET', '/api/health', { auth: 'none' }),
      ]) {
        expect(r.headers['set-cookie']).toBeUndefined();
        expect(r.headers.location).toBeUndefined();
      }
    });

    it('grants no cross-origin access: a preflight gets no permission headers', async () => {
      // This is what stops another site from sending the token header at all.
      const r = await call('OPTIONS', '/api/sessions', {
        auth: 'none',
        headers: { origin: 'http://evil.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-shellyard-token' },
      });
      expect(r.status).toBe(401);
      for (const name of Object.keys(r.headers)) expect(name.startsWith('access-control-')).toBe(false);
    });

    it('does not accept a cookie as a credential', async () => {
      const r = await call('GET', '/api/sessions', { auth: 'none', headers: { cookie: `shellyard_auth=${TOKEN}` } });
      expect(r.status).toBe(401);
    });

    it('refuses a state-changing request that names another origin, even with the token', async () => {
      const body = JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir() });
      const r = await call('POST', '/api/sessions', { body, headers: { origin: 'http://127.0.0.1:3000' } });
      expect(r.status).toBe(403);
      expect(mgr.list()).toEqual([]);
      expect((await call('POST', '/api/shutdown', { headers: { origin: 'http://evil.com' } })).status).toBe(403);
      expect(shutdowns).toBe(0);
    });

    it('accepts a state-changing request from its own origin', async () => {
      const body = JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir() });
      const r = await call('POST', '/api/sessions', { body, headers: { origin: `http://127.0.0.1:${port}` } });
      expect(r.status).toBe(201);
    });

    it('rejects an oversized body', async () => {
      const r = await call('POST', '/api/sessions', { body: 'x'.repeat(2 * 1024 * 1024) }).catch(() => ({ status: 413 }) as Res);
      expect(r.status).toBe(413);
      expect(mgr.list()).toEqual([]);
    });
  });

  describe('sessions', () => {
    it('creates, lists, updates, acknowledges and deletes', async () => {
      const created = await call('POST', '/api/sessions', { body: JSON.stringify({ profileId: 'builtin-node', cwd: home.dir(), name: 'one' }) });
      expect(created.status).toBe(201);
      const s = created.json();
      expect(s).toMatchObject({ name: 'one', status: 'running', color: '#123456' });

      expect((await call('GET', '/api/sessions')).json()).toHaveLength(1);

      const patched = await call('PATCH', `/api/sessions/${s.id}`, { body: JSON.stringify({ name: 'two' }) });
      expect(patched.json().name).toBe('two');

      const c = await newSession('claude');
      mgr.hook(c.id, 'Stop', false);
      const acked = await call('POST', `/api/sessions/${c.id}/ack`);
      expect(acked.json()).toMatchObject({ status: 'idle' });

      expect((await call('DELETE', `/api/sessions/${s.id}`)).status).toBe(204);
      expect(mgr.get(s.id)).toBeNull();
    });

    it('answers 404 for unknown sessions', async () => {
      expect((await call('PATCH', '/api/sessions/nope', { body: '{}' })).status).toBe(404);
      expect((await call('POST', '/api/sessions/nope/ack')).status).toBe(404);
      expect((await call('DELETE', '/api/sessions/nope')).status).toBe(404);
    });

    it('answers 400 for a body that is not a JSON object', async () => {
      expect((await call('POST', '/api/sessions', { body: '{oops' })).status).toBe(400);
      expect((await call('POST', '/api/sessions', { body: '[1,2]' })).status).toBe(400);
      expect(mgr.list()).toEqual([]);
    });

    it('ignores fields of the wrong type instead of crashing', async () => {
      const r = await call('POST', '/api/sessions', { body: JSON.stringify({ kind: 'shell', command: process.execPath, cwd: home.dir(), args: 'not-an-array', name: 42 }) });
      expect(r.status).toBe(201);
      expect(r.json().args).toEqual([]);
    });

    it('answers 404 for an unknown api route and 405 for a wrong method', async () => {
      expect((await call('GET', '/api/nope')).status).toBe(404);
      expect((await call('PUT', '/api/sessions')).status).toBe(405);
    });
  });

  describe('meta and profiles', () => {
    it('lists saved profiles first, then built-ins not overridden, with the models', async () => {
      const mine: Profile = { ...builtin, id: 'mine', name: 'Mine' };
      const override: Profile = { ...builtin, name: 'Node (mine)' };
      const saved = await call('PUT', '/api/profiles', { body: JSON.stringify([mine, override]) });
      expect(saved.status).toBe(200);
      const meta = (await call('GET', '/api/meta')).json();
      expect(meta.profiles.map((p: Profile) => p.name)).toEqual(['Mine', 'Node (mine)']);
      expect(meta.models).toEqual(['opus', 'sonnet', 'haiku']);
      expect(loadConfig().config.profiles).toHaveLength(2);
    });

    it('keeps a built-in profile in its place when its settings are changed, and says which are saved', async () => {
      const custom: Profile = { ...builtin, id: 'mine', name: 'Mine' };
      const override: Profile = { ...builtin, cwd: home.dir() };
      await call('PUT', '/api/profiles', { body: JSON.stringify([custom, override]) });
      const meta = (await call('GET', '/api/meta')).json();
      expect(meta.profiles.find((p: Profile) => p.id === 'builtin-node').cwd).toBe(home.dir());
      expect(meta.saved.sort()).toEqual(['builtin-node', 'mine']);
      // Removing the override brings the built-in default back.
      await call('PUT', '/api/profiles', { body: JSON.stringify([custom]) });
      const after = (await call('GET', '/api/meta')).json();
      expect(after.profiles.find((p: Profile) => p.id === 'builtin-node').cwd).toBe('');
      expect(after.saved).toEqual(['mine']);
    });

    it('starts a session from a profile in the folder saved for it', async () => {
      const work = join(home.dir(), 'work');
      mkdirSync(work);
      await call('PUT', '/api/profiles', { body: JSON.stringify([{ ...builtin, cwd: work }]) });
      const s = (await call('POST', '/api/sessions', { body: JSON.stringify({ profileId: 'builtin-node' }) })).json();
      expect(s).toMatchObject({ cwd: work, status: 'running' });
    });

    it('rejects profiles that are not a list', async () => {
      expect((await call('PUT', '/api/profiles', { body: '{"a":1}' })).status).toBe(400);
    });
  });

  describe('hooks', () => {
    it('applies a hook event', async () => {
      const c = await newSession('claude');
      const r = await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }) });
      expect(r.status).toBe(204);
      expect(mgr.get(c.id)!.status).toBe('working');
    });

    it('passes the idle-reminder flag through', async () => {
      const c = await newSession('claude');
      await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }) });
      expect(mgr.get(c.id)!.status).toBe('idle');
      await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }) });
      expect(mgr.get(c.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
    });

    it('answers 400 for a malformed body or unknown event, changing nothing', async () => {
      const c = await newSession('claude');
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: '{"hook_event_name":"Sto' })).status).toBe(400);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Nope' }) })).status).toBe(400);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body: '' })).status).toBe(400);
      expect(mgr.get(c.id)!.status).toBe('idle');
    });

    it('answers 400, not 500, for a session id that cannot be decoded', async () => {
      const r = await call('POST', '/api/hooks/%E0%A4%A', { auth: 'hook', body: JSON.stringify({ hook_event_name: 'Stop' }) });
      expect(r.status).toBe(400);
      expect((await call('DELETE', '/api/sessions/%E0%A4%A')).status).toBe(400);
    });

    it('answers 404 for an unknown session and for an exited one', async () => {
      const body = JSON.stringify({ hook_event_name: 'Stop' });
      expect((await call('POST', '/api/hooks/nope', { auth: 'hook', body })).status).toBe(404);
      const c = await newSession('claude');
      ptys.last().exit(0);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'hook', body })).status).toBe(404);
      expect(mgr.get(c.id)!.status).toBe('exited');
    });

    it('answers 403 without the hook token, even with the user token', async () => {
      const c = await newSession('claude');
      const body = JSON.stringify({ hook_event_name: 'Stop' });
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'user', body })).status).toBe(403);
      expect((await call('POST', `/api/hooks/${c.id}`, { auth: 'none', body })).status).toBe(403);
      expect(mgr.get(c.id)!.status).toBe('idle');
    });
  });

  describe('static files', () => {
    it('serves the app and its assets with a content type', async () => {
      const index = await call('GET', '/');
      expect(index.status).toBe(200);
      expect(index.text).toContain('ShellYard APP');
      expect(String(index.headers['content-type'])).toContain('text/html');
      const js = await call('GET', '/assets/app.js');
      expect(js.text).toBe('console.log(1)');
      expect(String(js.headers['content-type'])).toContain('javascript');
    });

    it('sends a content security policy that allows its own websocket and nothing foreign', async () => {
      const csp = String((await call('GET', '/', { auth: 'none' })).headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain('unsafe-eval');
    });

    it('refuses to change anything through a static path', async () => {
      expect((await call('POST', '/', { auth: 'none', body: '{}' })).status).toBe(405);
    });

    it('falls back to the app for an unknown page path, but not for a missing asset', async () => {
      expect((await call('GET', '/some/view')).text).toContain('ShellYard APP');
      expect((await call('GET', '/assets/missing.js')).status).toBe(404);
    });

    it('never serves a file outside the web folder', async () => {
      for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/%2e%2e%5csecret.txt']) {
        const r = await call('GET', path);
        expect(r.text, path).not.toContain('TOP SECRET');
      }
    });
  });

  describe('usage', () => {
    // A limit window that is still open, whenever the test runs.
    const resets5 = Math.floor(Date.now() / 1000) + 3600;
    const status = (cost: number, model = 'Opus') => JSON.stringify({
      model: { id: 'claude-' + model.toLowerCase(), display_name: model },
      cost: { total_cost_usd: cost },
      context_window: { total_input_tokens: 1000, total_output_tokens: 50 },
      rate_limits: { five_hour: { used_percentage: 58, resets_at: resets5 }, seven_day: { used_percentage: 31, resets_at: resets5 + 86400 } },
    });

    it('is empty at first, and needs the token', async () => {
      expect((await call('GET', '/api/usage', { auth: 'none' })).status).toBe(401);
      const u = (await call('GET', '/api/usage')).json();
      expect(u.today).toEqual({ costUsd: 0, byModel: [], byStory: [] });
      expect(u.limits).toEqual({ fiveHour: null, sevenDay: null, readAt: null });
    });

    it('records what a session reports as it goes, under its story, and updates its model', async () => {
      const story = (await call('POST', '/api/stories', { body: JSON.stringify({ name: 'Payroll' }) })).json();
      const c = (await call('POST', '/api/sessions', { body: JSON.stringify({ kind: 'claude', command: process.execPath, cwd: home.dir(), storyId: story.id, model: 'opus' }) })).json();
      const r = await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: status(1.25, 'Haiku') });
      expect(r.status).toBe(204);
      const u = (await call('GET', '/api/usage')).json();
      expect(u.today.costUsd).toBeCloseTo(1.25);
      expect(u.today.byModel).toEqual([{ key: 'claude-haiku', label: 'Haiku', tokensIn: 1000, tokensOut: 50, costUsd: 1.25 }]);
      expect(u.today.byStory.map((l: { label: string }) => l.label)).toEqual(['Payroll']);
      expect(u.limits.fiveHour).toEqual({ usedPercentage: 58, resetsAt: resets5 * 1000 });
      expect(mgr.get(c.id)!.model).toBe('Haiku');
    });

    it('accepts a status report only with the hook token, for a session that exists', async () => {
      const c = await newSession('claude');
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'user', body: status(1) })).status).toBe(403);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'none', body: status(1) })).status).toBe(403);
      expect((await call('POST', '/api/status/nope', { auth: 'hook', body: status(1) })).status).toBe(404);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: '{ nope' })).status).toBe(400);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: '"text"' })).status).toBe(400);
      expect((await call('GET', '/api/usage')).json().today.costUsd).toBe(0);
    });

    it('still accepts the last report of a session that has just exited', async () => {
      const c = await newSession('claude');
      ptys.last().exit(0);
      expect((await call('POST', `/api/status/${c.id}`, { auth: 'hook', body: status(2) })).status).toBe(204);
      const u = (await call('GET', '/api/usage')).json();
      expect(u.limits.fiveHour.usedPercentage).toBe(58);
      expect(u.today.costUsd).toBeCloseTo(2);
    });
  });

  describe('folders', () => {
    it('lists sub-folders for the folder picker, and needs the token', async () => {
      mkdirSync(join(home.dir(), 'projects'));
      expect((await call('GET', `/api/folders?path=${encodeURIComponent(home.dir())}`, { auth: 'none' })).status).toBe(401);
      const r = await call('GET', `/api/folders?path=${encodeURIComponent(home.dir())}`);
      expect(r.status).toBe(200);
      expect(r.json().path).toBe(home.dir());
      expect(r.json().folders.map((f: { name: string }) => f.name)).toContain('projects');
    });

    it('answers 400 with the reason for a path that cannot be listed', async () => {
      const r = await call('GET', `/api/folders?path=${encodeURIComponent(join(home.dir(), 'nope'))}`);
      expect(r.status).toBe(400);
      expect(r.json().error).toMatch(/does not exist/i);
    });

    it('starts from the home folder with no path', async () => {
      expect((await call('GET', '/api/folders')).status).toBe(200);
    });
  });

  it('shuts down on request', async () => {
    expect((await call('POST', '/api/shutdown')).status).toBe(204);
    expect(shutdowns).toBe(1);
  });
});
