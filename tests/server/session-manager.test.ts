import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../../src/server/config.js';
import { SessionManager } from '../../src/server/session-manager.js';
import type { Profile, SessionInfo } from '../../src/shared/types.js';
import { FakeClock, fakePtyFactory, useTempHome } from '../helpers.js';

const node = process.execPath;

describe('SessionManager', () => {
  const home = useTempHome();
  let clock: FakeClock;
  let ptys: ReturnType<typeof fakePtyFactory>;
  let config: Config;
  let mgr: SessionManager;
  let tmp: string;

  beforeEach(() => {
    clock = new FakeClock();
    ptys = fakePtyFactory();
    config = defaultConfig();
    tmp = join(home.dir(), 'work');
    mkdirSync(tmp);
    mgr = new SessionManager({
      ptyFactory: ptys.factory,
      now: clock.now,
      config: () => config,
      port: 7717,
      hookToken: 'hook-token',
      hookScriptPath: '/pkg/dist/hook/hook.js',
      statusScriptPath: '/pkg/dist/hook/statusline.js',
      builtins: () => [],
    });
  });

  const shell = (extra = {}): SessionInfo => mgr.create({ kind: 'shell', command: node, cwd: tmp, ...extra });
  const claude = (extra = {}): SessionInfo => mgr.create({ kind: 'claude', command: node, cwd: tmp, ...extra });

  describe('create', () => {
    it('starts a shell as running and a claude session as idle', () => {
      expect(shell()).toMatchObject({ kind: 'shell', status: 'running', reason: null, exitCode: null, error: null, cols: 120, rows: 30 });
      expect(claude()).toMatchObject({ kind: 'claude', status: 'idle', reason: null });
      expect(mgr.list()).toHaveLength(2);
    });

    it('creates an exited session with an error when the folder is missing', () => {
      const s = mgr.create({ kind: 'shell', command: node, cwd: join(tmp, 'nope') });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/folder/i);
      expect(ptys.ptys).toHaveLength(0);
      expect(mgr.get(s.id)).toEqual(s);
    });

    it('creates an exited session when the command does not resolve', () => {
      const s = mgr.create({ kind: 'shell', command: 'definitely-not-a-command-xyz', cwd: tmp });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/not found/i);
    });

    it('creates an exited session when there is no command at all', () => {
      const s = mgr.create({});
      expect(s.status).toBe('exited');
      expect(s.error).toBeTruthy();
    });

    it('creates an exited session when the process cannot be started', () => {
      const failing = new SessionManager({
        ptyFactory: () => {
          throw new Error('access denied');
        },
        now: clock.now,
        config: () => config,
        port: 1,
        hookToken: 't',
        hookScriptPath: '/h.js', statusScriptPath: '/s.js',
        builtins: () => [],
      });
      const s = failing.create({ kind: 'shell', command: node, cwd: tmp });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/access denied/);
    });

    it('accepts a folder with spaces and non-ASCII characters', () => {
      const dir = join(tmp, 'café – été');
      mkdirSync(dir);
      expect(mgr.create({ kind: 'shell', command: node, cwd: dir }).status).toBe('running');
      expect(ptys.last().opts.cwd).toBe(dir);
    });

    it('takes its settings from a saved profile, with the request winning', () => {
      const profile: Profile = { id: 'p1', name: 'My shell', kind: 'shell', command: node, args: ['-i'], cwd: tmp, color: '#112233', env: { FOO: 'bar' }, model: null };
      config.profiles = [profile];
      const s = mgr.create({ profileId: 'p1', name: 'Renamed' });
      expect(s).toMatchObject({ name: 'Renamed', color: '#112233', cwd: tmp, args: ['-i'], status: 'running' });
      expect(ptys.last().opts.env.FOO).toBe('bar');
      expect(ptys.last().launch.args).toEqual(['-i']);
    });

    it('reports an unknown profile as an error', () => {
      const s = mgr.create({ profileId: 'missing' });
      expect(s.status).toBe('exited');
      expect(s.error).toMatch(/launcher/i);
    });

    it('names a session after its command when nothing else is given', () => {
      expect(shell().name).toMatch(/^node/i);
      expect(shell({ name: '  ' }).name).toMatch(/^node/i);
    });

    it('launches a claude session with its own id, settings file, hook environment and model', () => {
      const s = claude({ model: 'opus' });
      const p = ptys.last();
      const args = p.launch.args;
      expect(args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2)).toEqual(['--session-id', s.id]);
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
      expect(p.opts.env).toMatchObject({ TTC_SESSION_ID: s.id, TTC_PORT: '7717', TTC_HOOK_TOKEN: 'hook-token' });
      expect(existsSync(join(home.dir(), 'run', `${s.id}.settings.json`))).toBe(true);
      expect(s.model).toBe('opus');
    });

    it('does not pass Claude flags to a shell', () => {
      shell({ model: 'opus' });
      expect(ptys.last().launch.args).toEqual([]);
      expect(ptys.last().opts.env.TTC_SESSION_ID).toBeUndefined();
    });

    it('does not leak nested-session markers into hosted sessions', () => {
      process.env.CLAUDE_CODE_CHILD_SESSION = '1';
      try {
        shell();
        expect(ptys.last().opts.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      } finally {
        delete process.env.CLAUDE_CODE_CHILD_SESSION;
      }
    });
  });

  describe('status', () => {
    it('follows hook events', () => {
      const s = claude();
      expect(mgr.hook(s.id, 'UserPromptSubmit', false)).toBe(true);
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
      mgr.hook(s.id, 'Notification', false);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'finished' });
    });

    it('rejects hooks for unknown and exited sessions', () => {
      expect(mgr.hook('nope', 'Stop', false)).toBe(false);
      const s = claude();
      ptys.last().exit(0);
      expect(mgr.hook(s.id, 'Stop', false)).toBe(false);
      expect(mgr.get(s.id)!.status).toBe('exited');
    });

    it('marks a working session maybe-waiting after 5000 ms of silence', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      clock.advance(4999);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('working');
      clock.advance(1);
      mgr.tick();
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('measures silence from the moment work started, not from stale output', () => {
      const s = claude();
      ptys.last().emit('banner');
      clock.advance(600_000);
      mgr.hook(s.id, 'UserPromptSubmit', false);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('working');
    });

    it('uses the configured silence threshold', () => {
      config.silenceMs = 20_000;
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      clock.advance(19_000);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('working');
      clock.advance(1_000);
      mgr.tick();
      expect(mgr.get(s.id)!.status).toBe('attention');
    });

    it('output keeps a working session working', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      for (let i = 0; i < 10; i++) {
        clock.advance(1000);
        ptys.last().emit('.');
        mgr.tick();
      }
      expect(mgr.get(s.id)!.status).toBe('working');
    });

    it('the echo of the user typing does not count as the session being active', () => {
      const s = claude();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      for (let i = 0; i < 6; i++) {
        clock.advance(1000);
        mgr.input(s.id, 'x');
        clock.advance(50);
        ptys.last().emit('x');
        mgr.tick();
      }
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('never applies the silence rule to idle, finished or shell sessions', () => {
      const a = claude();
      const b = claude();
      mgr.hook(b.id, 'Stop', false);
      const c = shell();
      clock.advance(60_000);
      mgr.tick();
      expect(mgr.get(a.id)!.status).toBe('idle');
      expect(mgr.get(b.id)).toMatchObject({ status: 'attention', reason: 'finished' });
      expect(mgr.get(c.id)!.status).toBe('running');
    });

    function makeMaybeWaiting(): { s: SessionInfo; pty: ReturnType<typeof ptys.last> } {
      const s = claude();
      const pty = ptys.last();
      mgr.hook(s.id, 'UserPromptSubmit', false);
      clock.advance(5000);
      mgr.tick();
      expect(mgr.get(s.id)!.reason).toBe('maybe-waiting');
      return { s, pty };
    }

    it('echo within 500 ms of input does not clear maybe-waiting', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.input(s.id, 'h');
      clock.advance(100);
      pty.emit('h');
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('unsolicited output clears maybe-waiting', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.input(s.id, 'h');
      clock.advance(600);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('the redraw a program does after a resize does not clear maybe-waiting', () => {
      // Showing a waiting session resizes its terminal, and the program repaints in response.
      const { s, pty } = makeMaybeWaiting();
      mgr.resize(s.id, 100, 40);
      clock.advance(300);
      pty.emit('\x1b[2J…full repaint…');
      clock.advance(900);
      pty.emit('…more repaint…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('output well after a resize still clears maybe-waiting', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.resize(s.id, 100, 40);
      clock.advance(1600);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('a resize request that changes nothing opens no quiet window', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.resize(s.id, 120, 30);
      clock.advance(300);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('input on a blocked session moves it to working, and silence brings it back if nothing happens', () => {
      const s = claude();
      mgr.hook(s.id, 'PreToolUse', false);
      mgr.hook(s.id, 'Notification', false);
      mgr.input(s.id, '\x1b');
      expect(mgr.get(s.id)!.status).toBe('working');
      expect(ptys.last().written).toEqual(['\x1b']);
      clock.advance(5000);
      mgr.tick();
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
    });

    it('a reply the terminal sends by itself is delivered but is not taken for the user answering', () => {
      const s = claude();
      mgr.hook(s.id, 'PreToolUse', false);
      mgr.hook(s.id, 'Notification', false);
      mgr.input(s.id, '\x1b[I');
      mgr.input(s.id, '\x1b[12;40R');
      expect(ptys.last().written).toEqual(['\x1b[I', '\x1b[12;40R']);
      expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'blocked' });
    });

    it('a terminal reply does not open the echo window that hides real output', () => {
      const { s, pty } = makeMaybeWaiting();
      mgr.input(s.id, '\x1b[I');
      clock.advance(100);
      pty.emit('Working…');
      expect(mgr.get(s.id)).toMatchObject({ status: 'working', reason: null });
    });

    it('ack moves a finished session to idle', () => {
      const s = claude();
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.ack(s.id)).toMatchObject({ status: 'idle', reason: null });
      expect(mgr.ack('nope')).toBeNull();
    });

    it('updates statusSince only when the status or reason changes', () => {
      const s = claude();
      clock.advance(10);
      mgr.hook(s.id, 'PreToolUse', false);
      const since = mgr.get(s.id)!.statusSince;
      expect(since).toBe(clock.now());
      clock.advance(10);
      mgr.hook(s.id, 'PostToolUse', false);
      expect(mgr.get(s.id)!.statusSince).toBe(since);
      clock.advance(10);
      mgr.hook(s.id, 'Stop', false);
      expect(mgr.get(s.id)!.statusSince).toBe(clock.now());
    });

    it('records the exit code, keeps the session listed and removes its settings file', () => {
      const s = claude();
      const settings = join(home.dir(), 'run', `${s.id}.settings.json`);
      expect(existsSync(settings)).toBe(true);
      ptys.last().exit(7);
      expect(mgr.get(s.id)).toMatchObject({ status: 'exited', exitCode: 7 });
      expect(mgr.list().map((x) => x.id)).toContain(s.id);
      expect(existsSync(settings)).toBe(false);
    });
  });

  describe('operations', () => {
    it('follows the model the session is really using, announcing only a real change', () => {
      const s = claude({ model: 'opus' });
      let changes = 0;
      mgr.onChange(() => changes++);
      mgr.setModel(s.id, 'Haiku 5.5');
      expect(mgr.get(s.id)!.model).toBe('Haiku 5.5');
      mgr.setModel(s.id, 'Haiku 5.5');
      mgr.setModel('nope', 'x');
      expect(changes).toBe(1);
    });

    it('renames and recolours', () => {
      const s = shell();
      expect(mgr.update(s.id, { name: 'build', color: '#00ff00' })).toMatchObject({ name: 'build', color: '#00ff00' });
      expect(mgr.update(s.id, { name: '   ' })!.name).toBe('build');
      expect(mgr.update('nope', { name: 'x' })).toBeNull();
    });

    it('forwards resize and exposes the new size', () => {
      const s = shell();
      mgr.resize(s.id, 100, 40);
      expect(ptys.last().resizes).toEqual([[100, 40]]);
      expect(mgr.get(s.id)).toMatchObject({ cols: 100, rows: 40 });
      mgr.resize('nope', 10, 10);
    });

    it('gives a snapshot for a live session, an empty one for a failed start, null for unknown', async () => {
      const s = shell();
      ptys.last().emit('hello');
      expect(await mgr.snapshot(s.id)).toContain('hello');
      const failed = mgr.create({ kind: 'shell', command: 'definitely-not-a-command-xyz', cwd: tmp });
      expect(await mgr.snapshot(failed.id)).toBe('');
      expect(await mgr.snapshot('nope')).toBeNull();
    });

    it('remove kills a running process and forgets the session', () => {
      const s = shell();
      const pty = ptys.last();
      expect(mgr.remove(s.id)).toBe(true);
      expect(pty.killed).toBe(true);
      expect(mgr.list()).toEqual([]);
      expect(mgr.get(s.id)).toBeNull();
      expect(mgr.remove(s.id)).toBe(false);
    });

    it('shutdown kills everything and cleans up', () => {
      const a = claude();
      shell();
      const [p1, p2] = ptys.ptys;
      mgr.shutdown();
      expect(p1!.killed && p2!.killed).toBe(true);
      expect(existsSync(join(home.dir(), 'run', `${a.id}.settings.json`))).toBe(false);
    });
  });

  describe('events', () => {
    it('announces every change with the full list', () => {
      const seen: SessionInfo[][] = [];
      mgr.onChange((s) => seen.push(s));
      const s = claude();
      expect(seen).toHaveLength(1);
      mgr.hook(s.id, 'UserPromptSubmit', false);
      expect(seen).toHaveLength(2);
      expect(seen[1]![0]!.status).toBe('working');
      mgr.hook(s.id, 'PreToolUse', false);
      expect(seen).toHaveLength(2);
      mgr.update(s.id, { name: 'x' });
      mgr.resize(s.id, 90, 20);
      mgr.remove(s.id);
      expect(seen).toHaveLength(5);
      expect(seen[4]).toEqual([]);
    });

    it('forwards output with the session id', () => {
      const out: Array<[string, string]> = [];
      mgr.onOutput((id, data) => out.push([id, data]));
      const s = shell();
      ptys.last().emit('abc');
      expect(out).toEqual([[s.id, 'abc']]);
    });
  });
});
