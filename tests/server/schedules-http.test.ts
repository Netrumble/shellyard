import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultConfig, saveConfig } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import type { Schedule, ServerMessage, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome, waitUntil } from '../helpers.js';

const node = process.execPath;

describe('schedules over http, websocket and a restart', () => {
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
  const call = async (s: RunningServer, method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> => {
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
      method,
      headers: { ...(auth ? { 'x-shellyard-token': s.token } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const fromClaude = async (s: RunningServer, path: string, body: unknown): Promise<number> => {
    const hookToken = JSON.parse(readFileSync(join(home.dir(), 'server.json'), 'utf8')).hookToken as string;
    return (await fetch(`http://127.0.0.1:${s.port}${path}`, { method: 'POST', headers: { 'x-shellyard-hook-token': hookToken }, body: JSON.stringify(body) })).status;
  };
  const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'Nightly check',
    prompt: 'Check the build.\nReport what fails.',
    profileId: 'test-claude',
    when: { kind: 'interval', minutes: 60 },
    ...over,
  });

  beforeEach(() => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    mkdirSync(work);
    saveConfig({
      ...defaultConfig(),
      profiles: [
        { id: 'test-claude', name: 'Test Claude', kind: 'claude', command: node, args: ['--verbose'], cwd: work, color: '#d97757', env: {}, model: null },
        { id: 'test-shell', name: 'Test shell', kind: 'shell', command: node, args: [], cwd: work, color: '#2f6fde', env: {}, model: null },
      ],
    });
  });
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  it('creates, lists, changes and deletes a schedule', async () => {
    const s = await start();
    expect((await call(s, 'GET', '/api/schedules')).json).toEqual([]);
    const made = await call(s, 'POST', '/api/schedules', input());
    expect(made.status).toBe(201);
    const id = (made.json as Schedule).id;
    expect((await call(s, 'GET', '/api/schedules')).json).toHaveLength(1);
    const patched = await call(s, 'PATCH', `/api/schedules/${id}`, { enabled: false });
    expect(patched.json).toMatchObject({ enabled: false, nextRunAt: null });
    expect((await call(s, 'DELETE', `/api/schedules/${id}`)).status).toBe(204);
    expect((await call(s, 'GET', '/api/schedules')).json).toEqual([]);
  });

  it('answers a schedule that could not run with the reason', async () => {
    const s = await start();
    const bad = await call(s, 'POST', '/api/schedules', input({ prompt: '' }));
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/prompt/i);
    expect((await call(s, 'PATCH', '/api/schedules/nope', { name: 'x' })).status).toBe(404);
    expect((await call(s, 'DELETE', '/api/schedules/nope')).status).toBe(404);
    expect((await call(s, 'POST', '/api/schedules/nope/run')).status).toBe(404);
    expect((await call(s, 'PUT', '/api/schedules', {})).status).toBe(405);
  });

  it('needs the token', async () => {
    const s = await start();
    expect((await call(s, 'GET', '/api/schedules', undefined, false)).status).toBe(401);
    expect((await call(s, 'POST', '/api/schedules', input(), false)).status).toBe(401);
  });

  it('runs a schedule: a session in its area, then the prompt typed when Claude Code is ready', async () => {
    const s = await start();
    const area = (await call(s, 'POST', '/api/stories', { name: 'Builds' })).json as { id: string };
    const made = (await call(s, 'POST', '/api/schedules', input({ storyId: area.id, permissionMode: 'plan', model: 'opus' }))).json as Schedule;

    const run = await call(s, 'POST', `/api/schedules/${made.id}/run`);
    expect(run.status).toBe(200);
    expect(run.json).toMatchObject({ outcome: 'started', manual: true });
    const sessionId = run.json.sessionId as string;
    const session = ((await call(s, 'GET', '/api/sessions')).json as SessionInfo[]).find((x) => x.id === sessionId)!;
    expect(session).toMatchObject({ kind: 'claude', name: 'Nightly check', storyId: area.id, cwd: work, model: 'opus' });

    // The prompt is not on the command line; the permission mode and the profile's own arguments are.
    const pty = ptys.last();
    const line = Array.isArray(pty.launch.args) ? pty.launch.args.join(' ') : pty.launch.args;
    expect(line).toContain('--permission-mode plan');
    expect(line).toContain('--verbose');
    expect(line).not.toContain('Check the build');
    expect(pty.written).toEqual([]);

    // Claude Code draws its screen and reports a status line; the prompt is typed, then Enter.
    expect(await fromClaude(s, `/api/status/${sessionId}`, { model: { id: 'claude-opus', display_name: 'Opus' } })).toBe(204);
    await waitUntil(() => pty.written.length === 2);
    expect(pty.written).toEqual(['\x1b[200~Check the build.\nReport what fails.\x1b[201~', '\r']);

    // Claude Code says it took the prompt.
    expect(await fromClaude(s, `/api/hooks/${sessionId}`, { hook_event_name: 'UserPromptSubmit' })).toBe(204);
    await waitUntil(() => true);
    const after = ((await call(s, 'GET', '/api/schedules')).json as Schedule[])[0]!;
    expect(after.runs[0]).toMatchObject({ outcome: 'delivered', sessionId });
  });

  it('records a run that cannot start, and leaves no dead session behind', async () => {
    const s = await start();
    const notClaude = (await call(s, 'POST', '/api/schedules', input({ profileId: 'test-shell' }))).json as Schedule;
    expect((await call(s, 'POST', `/api/schedules/${notClaude.id}/run`)).json).toMatchObject({ outcome: 'failed', detail: 'The launcher "Test shell" does not start Claude Code.' });
    const gone = (await call(s, 'POST', '/api/schedules', input({ profileId: 'no-such-profile' }))).json as Schedule;
    expect((await call(s, 'POST', `/api/schedules/${gone.id}/run`)).json).toMatchObject({ outcome: 'failed', detail: 'The launcher of this schedule no longer exists.' });
    const badFolder = (await call(s, 'POST', '/api/schedules', input({ cwd: join(home.dir(), 'missing') }))).json as Schedule;
    const failed = (await call(s, 'POST', `/api/schedules/${badFolder.id}/run`)).json;
    expect(failed.outcome).toBe('failed');
    expect(failed.detail).toBeTruthy();
    expect((await call(s, 'GET', '/api/sessions')).json).toEqual([]);
  });

  it('runs outside any area once the area of a schedule is deleted', async () => {
    const s = await start();
    const area = (await call(s, 'POST', '/api/stories', { name: 'Builds' })).json as { id: string };
    const made = (await call(s, 'POST', '/api/schedules', input({ storyId: area.id }))).json as Schedule;
    await call(s, 'DELETE', `/api/stories/${area.id}`);
    expect(((await call(s, 'GET', '/api/schedules')).json as Schedule[])[0]!.storyId).toBeNull();
    const run = (await call(s, 'POST', `/api/schedules/${made.id}/run`)).json;
    expect(run.outcome).toBe('started');
    expect(((await call(s, 'GET', '/api/sessions')).json as SessionInfo[])[0]!.storyId).toBeNull();
  });

  it('pushes the list to the page on connect and on every change', async () => {
    const s = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, ['shellyard', `shellyard-token.${s.token}`], { headers: { origin: `http://127.0.0.1:${s.port}` } });
    const lists: string[][] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      if (m.t === 'schedules') lists.push(m.schedules.map((x) => x.name));
    });
    try {
      await waitUntil(() => lists.length === 1);
      await call(s, 'POST', '/api/schedules', input({ name: 'pushed' }));
      await waitUntil(() => lists.length === 2);
      expect(lists).toEqual([[], ['pushed']]);
    } finally {
      ws.terminate();
    }
  });

  it('keeps schedules across a restart', async () => {
    const first = await start();
    const made = (await call(first, 'POST', '/api/schedules', input())).json as Schedule;
    await first.stop();
    running.length = 0;
    const second = await start();
    expect(((await call(second, 'GET', '/api/schedules')).json as Schedule[]).map((x) => x.id)).toEqual([made.id]);
  });
});
