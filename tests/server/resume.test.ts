import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareClaudeLaunch } from '../../src/server/claude-launch.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { SessionManager } from '../../src/server/session-manager.js';
import { UsageStore } from '../../src/server/usage.js';
import type { Conversation, SessionInfo } from '../../src/shared/types.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

const node = process.execPath;
const CONV = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('launching Claude Code on an existing conversation', () => {
  useTempHome();
  const base = { sessionId: 'sess-1', port: 1, hookToken: 't', hookScriptPath: '/h.js', statusScriptPath: '/s.js', extraArgs: ['--verbose'], model: 'opus' };

  it('resumes the conversation instead of naming a new one', () => {
    const out = prepareClaudeLaunch({ ...base, resumeId: CONV });
    expect(out.args).toEqual(['--settings', out.settingsPath, '--resume', CONV, '--model', 'opus', '--verbose']);
  });

  it('names a new conversation when there is nothing to resume', () => {
    const out = prepareClaudeLaunch({ ...base, resumeId: null });
    expect(out.args.slice(2, 4)).toEqual(['--session-id', 'sess-1']);
  });
});

describe('sessions and conversations', () => {
  const home = useTempHome();
  let ptys: ReturnType<typeof fakePtyFactory>;
  let mgr: SessionManager;
  let work = '';
  let known: Conversation[];

  beforeEach(() => {
    ptys = fakePtyFactory();
    work = join(home.dir(), 'work');
    mkdirSync(work);
    known = [{ id: CONV, cwd: work, title: 'Export bug fix', updatedAt: 5 }];
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: Date.now,
      config: defaultConfig,
      port: 1,
      hookToken: 'h',
      hookScriptPath: '/h.js',
      statusScriptPath: '/s.js',
      builtins: () => [{ id: 'builtin-claude', name: 'Claude Code', kind: 'claude', command: node, args: [], cwd: home.dir(), color: '#d97757', env: { FROM_PROFILE: '1' }, model: null }],
      findConversation: (id) => known.find((c) => c.id === id) ?? null,
    });
  });

  it('resumes a conversation in its own folder, named after it, with the Claude profile', () => {
    const s = mgr.create({ resume: CONV });
    expect(s).toMatchObject({ kind: 'claude', cwd: work, name: 'Export bug fix', resumed: true, status: 'idle', error: null });
    const args = ptys.last().launch.args as string[];
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', CONV]);
    expect(args).not.toContain('--session-id');
    expect(ptys.last().opts.cwd).toBe(work);
    expect(ptys.last().opts.env.FROM_PROFILE).toBe('1');
  });

  it('lets the request choose the name, colour and story of a resumed session', () => {
    const s = mgr.create({ resume: CONV, name: 'my name', color: '#00ff00' });
    expect(s).toMatchObject({ name: 'my name', color: '#00ff00', cwd: work });
  });

  it('reports a conversation that cannot be found, or whose folder is gone', () => {
    expect(mgr.create({ resume: OTHER })).toMatchObject({ status: 'exited', resumed: false });
    expect(mgr.create({ resume: OTHER }).error).toMatch(/conversation/i);
    known.push({ id: OTHER, cwd: join(home.dir(), 'deleted'), title: 'x', updatedAt: 1 });
    expect(mgr.create({ resume: OTHER }).error).toMatch(/folder does not exist/i);
    expect(ptys.ptys).toHaveLength(0);
  });

  it('refuses to open a conversation that is already open here', () => {
    const first = mgr.create({ resume: CONV });
    const second = mgr.create({ resume: CONV });
    expect(second.status).toBe('exited');
    expect(second.error).toMatch(/already open/i);
    expect(ptys.ptys).toHaveLength(1);
    // Once the first one has ended it can be opened again.
    ptys.last().exit(0);
    expect(mgr.create({ resume: CONV }).status).toBe('idle');
    expect(mgr.get(first.id)!.status).toBe('exited');
  });

  it('a new Claude session is not marked as resumed, and its conversation is its own id', () => {
    const s = mgr.create({ profileId: 'builtin-claude', cwd: work });
    expect(s.resumed).toBe(false);
    expect(mgr.openConversations().get(s.id)).toBe(s.id);
  });

  it('follows the conversation id Claude Code reports', () => {
    const s = mgr.create({ profileId: 'builtin-claude', cwd: work });
    mgr.setConversation(s.id, OTHER);
    expect(mgr.openConversations().get(OTHER)).toBe(s.id);
    mgr.setConversation(s.id, 'not-an-id');
    mgr.setConversation('nope', CONV);
    expect([...mgr.openConversations().keys()]).toEqual([OTHER]);
  });

  describe('what to bring back after a restart', () => {
    it('describes every session still running, and none that ended', () => {
      const shell = mgr.create({ kind: 'shell', command: node, args: ['-i'], cwd: work, name: 'build', color: '#123456' });
      const claude = mgr.create({ profileId: 'builtin-claude', cwd: work, model: 'opus' });
      mgr.setModel(claude.id, 'Opus 4.1');
      const gone = mgr.create({ kind: 'shell', command: node, cwd: work });
      ptys.last().exit(0);
      mgr.create({ kind: 'shell', command: 'definitely-not-a-command', cwd: work });
      const entries = mgr.restorable();
      expect(entries).toEqual([
        { kind: 'shell', profileId: null, name: 'build', color: '#123456', cwd: work, command: node, args: ['-i'], storyId: null, model: null, conversationId: null, background: null, font: null },
        // The model to launch with is the one that was asked for, not the display name reported later.
        { kind: 'claude', profileId: 'builtin-claude', name: 'Claude Code', color: '#d97757', cwd: work, command: node, args: [], storyId: null, model: 'opus', conversationId: claude.id, background: null, font: null },
      ]);
      expect(entries.some((e) => e.name === gone.name && e.command === node && e.args.length === 0 && e.kind === 'shell' && e.color === '#888888')).toBe(false);
      expect(shell.id).toBeTruthy();
    });
  });
});

describe('usage of a resumed conversation', () => {
  const home = useTempHome();
  const p = (costUsd: number) => ({ modelId: 'm', modelName: 'M', costUsd, tokensIn: 100, tokensOut: 10, fiveHour: null, sevenDay: null });

  it('does not count again what the conversation had already cost before it was resumed', () => {
    const store = new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') });
    // Claude Code restores the running total of the earlier run on resume.
    store.record('s1', p(4), { storyId: null, storyName: null, resumed: true });
    expect(store.summary().today.costUsd).toBe(0);
    store.record('s1', p(4.5), { storyId: null, storyName: null, resumed: true });
    expect(store.summary().today.costUsd).toBeCloseTo(0.5);
  });

  it('still counts a new session from zero', () => {
    const store = new UsageStore({ now: Date.now, file: join(home.dir(), 'usage.json') });
    store.record('s1', p(4), { storyId: null, storyName: null, resumed: false });
    expect(store.summary().today.costUsd).toBeCloseTo(4);
  });
});

describe('over http, and across a restart of the server', () => {
  const home = useTempHome();
  const running: RunningServer[] = [];
  let ptys: ReturnType<typeof fakePtyFactory>;
  let claudeDir = '';
  let work = '';
  let savedClaudeDir: string | undefined;

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
  const call = async (s: RunningServer, method: string, path: string, body?: unknown, hook = false): Promise<{ status: number; json: any }> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (hook) headers['x-cvm-hook-token'] = JSON.parse(readFileSync(join(home.dir(), 'server.json'), 'utf8')).hookToken;
    else headers['x-cvm-token'] = s.token;
    const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  function transcript(id: string, cwd: string, title: string): void {
    const dir = join(claudeDir, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, cwd }), JSON.stringify({ type: 'ai-title', aiTitle: title })].join('\n') + '\n');
  }

  beforeEach(() => {
    ptys = fakePtyFactory();
    claudeDir = join(home.dir(), 'claude');
    work = join(home.dir(), 'work');
    mkdirSync(work);
    mkdirSync(claudeDir);
    savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    // A Claude profile that runs something present on every machine.
    saveConfig({ ...defaultConfig(), profiles: [{ id: 'builtin-claude', name: 'Claude Code', kind: 'claude', command: node, args: [], cwd: work, color: '#d97757', env: {}, model: null }] });
  });
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
  });

  it('lists recent conversations and says which are open here', async () => {
    transcript(CONV, work, 'Export bug fix');
    transcript(OTHER, work, 'Something else');
    const s = await start();
    expect((await fetch(`http://127.0.0.1:${s.port}/api/conversations`)).status).toBe(401);
    const opened = (await call(s, 'POST', '/api/sessions', { resume: CONV })).json as SessionInfo;
    expect(opened).toMatchObject({ resumed: true, name: 'Export bug fix', cwd: work });
    const list = (await call(s, 'GET', '/api/conversations')).json as Array<{ id: string; title: string; openIn: string | null }>;
    expect(list.find((c) => c.id === CONV)).toMatchObject({ title: 'Export bug fix', openIn: opened.id });
    expect(list.find((c) => c.id === OTHER)).toMatchObject({ openIn: null });
  });

  it('refuses a resume request whose id is not a conversation id', async () => {
    const s = await start();
    const r = (await call(s, 'POST', '/api/sessions', { resume: '../../secret' })).json as SessionInfo;
    expect(r.status).toBe('exited');
    expect(r.error).toMatch(/conversation/i);
    expect(ptys.ptys).toHaveLength(0);
  });

  it('learns the conversation of a session from what Claude Code reports', async () => {
    transcript(OTHER, work, 'Switched to');
    const s = await start();
    const c = (await call(s, 'POST', '/api/sessions', { profileId: 'builtin-claude' })).json as SessionInfo;
    await call(s, 'POST', `/api/hooks/${c.id}`, { hook_event_name: 'UserPromptSubmit', session_id: OTHER }, true);
    const list = (await call(s, 'GET', '/api/conversations')).json as Array<{ id: string; openIn: string | null }>;
    expect(list.find((x) => x.id === OTHER)!.openIn).toBe(c.id);
  });

  it('reads the cost of conversations from their transcripts, under the story they are open in', async () => {
    const s = await start();
    const story = (await call(s, 'POST', '/api/stories', { name: 'Payroll' })).json;
    const stamp = new Date().toISOString();
    const dir = join(claudeDir, 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const lines = (id: string, cost: number): string =>
      [
        JSON.stringify({ parentUuid: null, type: 'user', message: { role: 'user', content: 'hello' }, cwd: work, timestamp: stamp, sessionId: id }),
        JSON.stringify({ type: 'cost-state', sessionId: id, modelUsage: { 'claude-m': { costUSD: cost, inputTokens: 100, outputTokens: 10 } } }),
      ].join('\n') + '\n';
    // One conversation held outside CVM, and one that is open here in a story.
    writeFileSync(join(dir, `${OTHER}.jsonl`), lines(OTHER, 2));
    writeFileSync(join(dir, `${CONV}.jsonl`), lines(CONV, 7));
    const c = (await call(s, 'POST', '/api/sessions', { resume: CONV, storyId: story.id })).json as SessionInfo;
    // Resumed: Claude Code restores the 7 already spent, then spends a quarter more.
    await call(s, 'POST', `/api/status/${c.id}`, { cost: { total_cost_usd: 7 }, model: { id: 'claude-m', display_name: 'Model M' } }, true);
    await call(s, 'POST', `/api/status/${c.id}`, { cost: { total_cost_usd: 7.25 }, model: { id: 'claude-m', display_name: 'Model M' } }, true);
    const settle = async (want: number): Promise<any> => {
      let usage: any;
      for (let i = 0; i < 80; i++) {
        usage = (await call(s, 'GET', '/api/usage')).json;
        if (Math.abs(usage.today.costUsd - want) < 1e-6) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return usage;
    };
    const usage = await settle(9.25);
    expect(usage.today.costUsd).toBeCloseTo(9.25);
    expect(usage.today.byModel.map((l: { key: string; label: string }) => [l.key, l.label])).toEqual([['claude-m', 'Model M']]);
    expect(usage.today.byStory.map((l: { label: string; costUsd: number }) => [l.label, l.costUsd])).toEqual([['Payroll', 7.25], ['No area', 2]]);
    // The session ends and its transcript catches up: the total must not move.
    appendFileSync(join(dir, `${CONV}.jsonl`), JSON.stringify({ type: 'cost-state', sessionId: CONV, modelUsage: { 'claude-m': { costUSD: 7.25, inputTokens: 100, outputTokens: 10 } } }) + '\n');
    await new Promise((r) => setTimeout(r, 4000));
    expect((await settle(9.25)).today.costUsd).toBeCloseTo(9.25);
  });

  it('brings the sessions back after a restart: Claude with its conversation, shells in their folder', async () => {
    const first = await start();
    const story = (await call(first, 'POST', '/api/stories', { name: 'Payroll' })).json;
    await call(first, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'build', color: '#123456', storyId: story.id });
    const claude = (await call(first, 'POST', '/api/sessions', { profileId: 'builtin-claude', name: 'backend', model: 'opus' })).json as SessionInfo;
    const fresh = (await call(first, 'POST', '/api/sessions', { profileId: 'builtin-claude', name: 'never prompted' })).json as SessionInfo;
    const closed = (await call(first, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'closed by the user' })).json as SessionInfo;
    await call(first, 'DELETE', `/api/sessions/${closed.id}`);
    // Claude Code wrote a transcript for the first one; the second never had a prompt.
    transcript(claude.id, work, 'Backend work');
    await new Promise((r) => setTimeout(r, 400));
    await first.stop();
    running.length = 0;
    const launchedBefore = ptys.ptys.length;

    const second = await start();
    const sessions = (await call(second, 'GET', '/api/sessions')).json as SessionInfo[];
    expect(sessions.map((s) => [s.name, s.kind, s.status, s.resumed])).toEqual([
      ['build', 'shell', 'running', false],
      ['backend', 'claude', 'idle', true],
      ['never prompted', 'claude', 'idle', false],
    ]);
    expect(sessions[0]).toMatchObject({ cwd: work, color: '#123456', storyId: story.id });
    const launched = ptys.ptys.slice(launchedBefore).map((p) => p.launch.args as string[]);
    expect(launched[1]!.slice(launched[1]!.indexOf('--resume'), launched[1]!.indexOf('--resume') + 2)).toEqual(['--resume', claude.id]);
    expect(launched[1]).toContain('opus');
    expect(launched[2]).toContain('--session-id');
    expect(launched[2]).not.toContain(fresh.id);
    expect(launched[2]).not.toContain('--resume');
  });

  it('does not bring back sessions when that is switched off', async () => {
    saveConfig({ ...loadConfig().config, restoreSessions: false });
    const first = await start();
    await call(first, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'build' });
    await new Promise((r) => setTimeout(r, 400));
    await first.stop();
    running.length = 0;
    const second = await start();
    expect((await call(second, 'GET', '/api/sessions')).json).toEqual([]);
  });

  it('starts normally when the saved list is damaged or its folders are gone', async () => {
    writeFileSync(join(home.dir(), 'sessions.json'), '{ broken');
    const a = await start();
    expect((await call(a, 'GET', '/api/sessions')).json).toEqual([]);
    await a.stop();
    running.length = 0;
    writeFileSync(join(home.dir(), 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ kind: 'shell', name: 'gone', cwd: join(home.dir(), 'deleted'), command: node, args: [], color: '#888888' }, 'junk', { kind: 'shell' }] }));
    const b = await start();
    const sessions = (await call(b, 'GET', '/api/sessions')).json as SessionInfo[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ name: 'gone', status: 'exited' });
    expect(sessions[0]!.error).toMatch(/folder does not exist/i);
  });

  it('keeps the saved list through an orderly stop, so that stopping is not mistaken for closing everything', async () => {
    const first = await start();
    await call(first, 'POST', '/api/sessions', { kind: 'shell', command: node, cwd: work, name: 'build' });
    await first.stop();
    running.length = 0;
    expect(existsSync(join(home.dir(), 'sessions.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home.dir(), 'sessions.json'), 'utf8')).sessions.map((s: { name: string }) => s.name)).toEqual(['build']);
  });
});
