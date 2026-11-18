import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureServer, isServerAlive, main, stopServer, writeLauncherPage } from '../../src/cli/shellyard.js';
import { readServerState, writeServerState } from '../../src/server/config.js';
import { startServer, type RunningServer } from '../../src/server/index.js';
import { fakePtyFactory, useTempHome } from '../helpers.js';

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function capture(): { lines: string[]; out: (s: string) => void } {
  const lines: string[] = [];
  return { lines, out: (s) => lines.push(s) };
}

describe('shellyard cli', () => {
  useTempHome();
  const running: RunningServer[] = [];
  const start = async (): Promise<RunningServer> => {
    const s = await startServer({ port: await freePort(), ptyFactory: fakePtyFactory().factory, quiet: true });
    running.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop();
  });

  describe('isServerAlive', () => {
    it('is false when nothing listens on the recorded port', async () => {
      expect(await isServerAlive({ pid: process.pid, port: await freePort(), token: 't', hookToken: 'h', startedAt: 0 })).toBe(false);
    });

    it('is false when the port belongs to some other program', async () => {
      const other = createServer((_req, res) => res.writeHead(404).end('nope'));
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
      const port = (other.address() as AddressInfo).port;
      try {
        expect(await isServerAlive({ pid: process.pid, port, token: 't', hookToken: 'h', startedAt: 0 })).toBe(false);
      } finally {
        await new Promise((r) => other.close(r));
      }
    });

    it('is false when another program answers 200 with something else', async () => {
      const other = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hi</html>'));
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
      const port = (other.address() as AddressInfo).port;
      try {
        expect(await isServerAlive({ pid: process.pid, port, token: 't', hookToken: 'h', startedAt: 0 })).toBe(false);
      } finally {
        await new Promise((r) => other.close(r));
      }
    });

    it('is false when a different ShellYard server answers on the recorded port', async () => {
      const s = await start();
      // Another server: it cannot prove it holds the recorded token.
      const stale = { ...readServerState()!, token: 'f'.repeat(64) };
      expect(await isServerAlive(stale)).toBe(false);
      expect(s.port).toBe(stale.port);
    });

    it('is false for an impostor that repeats the start time, and it is never sent the token', async () => {
      const real = await start();
      const state = readServerState()!;
      await real.stop();
      running.length = 0;
      writeServerState(state);
      const seen: string[] = [];
      const impostor = createServer((req, res) => {
        seen.push(String(req.headers['x-shellyard-token'] ?? ''));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'shellyard', startedAt: state.startedAt, proof: '0'.repeat(64) }));
      });
      await new Promise<void>((r) => impostor.listen(state.port, '127.0.0.1', r));
      try {
        expect(await isServerAlive(state)).toBe(false);
        const c = capture();
        expect(await main(['status'], c.out)).toBe(1);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((t) => t === '')).toBe(true);
      } finally {
        await new Promise((r) => impostor.close(r));
      }
    });

    it('is true for a real server', async () => {
      await start();
      expect(await isServerAlive(readServerState()!)).toBe(true);
    });
  });

  describe('status', () => {
    it('exits 1 with no server', async () => {
      const c = capture();
      expect(await main(['status'], c.out)).toBe(1);
      expect(c.lines.join('\n')).toMatch(/not running/i);
    });

    it('exits 1 and says so when the state file is stale', async () => {
      writeServerState({ pid: 999999, port: await freePort(), token: 't', hookToken: 'h', startedAt: 0 });
      const c = capture();
      expect(await main(['status'], c.out)).toBe(1);
      expect(c.lines.join('\n')).toMatch(/not running/i);
    });

    it('exits 0 and reports the port and session count', async () => {
      const s = await start();
      const c = capture();
      expect(await main(['status'], c.out)).toBe(0);
      expect(c.lines.join('\n')).toContain(String(s.port));
      expect(c.lines.join('\n')).toMatch(/0 sessions/);
    });
  });

  describe('stop', () => {
    it('stops a running server and clears the state file', async () => {
      const s = await start();
      const c = capture();
      expect(await main(['stop'], c.out)).toBe(0);
      await s.stopped;
      running.length = 0;
      expect(readServerState()).toBeNull();
      expect(await isServerAlive({ pid: process.pid, port: s.port, token: s.token, hookToken: 'h', startedAt: 0 })).toBe(false);
    });

    it('does not stop, or kill the recorded pid, when the port now belongs to another ShellYard', async () => {
      const s = await start();
      // A stale file pointing at a live ShellYard that did not write it; its pid is this test process.
      writeServerState({ pid: process.pid, port: s.port, token: 'stale-token', hookToken: 'h', startedAt: 12345 });
      const c = capture();
      expect(await main(['stop'], c.out)).toBe(0);
      expect(c.lines.join('\n')).toMatch(/not running/i);
      const res = await fetch('http://127.0.0.1:' + s.port + '/api/health');
      expect(res.ok).toBe(true);
    });

    it('clears a stale state file without killing anything', async () => {
      // The recorded pid is this test process: a stop that trusted the pid would kill it.
      writeServerState({ pid: process.pid, port: await freePort(), token: 't', hookToken: 'h', startedAt: 0 });
      const c = capture();
      expect(await main(['stop'], c.out)).toBe(0);
      expect(readServerState()).toBeNull();
      expect(c.lines.join('\n')).toMatch(/not running/i);
    });
  });

  describe('start', () => {
    it('accepts "start" as a word for the same thing', async () => {
      const s = await start();
      const c = capture();
      expect(await main(['start', '--no-open'], c.out)).toBe(0);
      expect(c.lines.join('\n')).toContain(`http://${s.pageHost}:${s.port}`);
      const help = capture();
      await main(['--help'], help.out);
      expect(help.lines.join('\n')).toMatch(/shellyard start/);
    });

    it('reuses a running server instead of starting another', async () => {
      const s = await start();
      const c = capture();
      expect(await main(['--no-open'], c.out)).toBe(0);
      expect(c.lines.join('\n')).toContain(`http://${s.pageHost}:${s.port}`);
      expect(readServerState()!.pid).toBe(process.pid);
    });
  });

  describe('version of the running server', () => {
    const appVersion = (): string => JSON.parse(readFileSync('package.json', 'utf8')).version;

    /** A server as an earlier ShellYard would answer: no version in its health check. */
    async function olderServer(): Promise<{ port: number; close: () => Promise<void> }> {
      const startedAt = 4242;
      const other = createServer((req, res) => {
        if (req.url?.startsWith('/api/health')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'shellyard', startedAt }));
        if (req.url === '/api/shutdown') {
          res.writeHead(204).end();
          return void setTimeout(() => other.close(), 20);
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
      const port = (other.address() as AddressInfo).port;
      writeServerState({ pid: process.pid, port, token: 't', hookToken: 'h', startedAt });
      return { port, close: () => new Promise<void>((r) => (other.listening ? other.close(() => r()) : r())) };
    }

    it('is not outdated when the server runs this version', async () => {
      await start();
      const r = await ensureServer();
      expect(r.ok && r.serverVersion).toBe(appVersion());
      expect(r.ok && r.outdated).toBe(false);
    });

    it('is outdated when the server does not report a version', async () => {
      const old = await olderServer();
      try {
        const r = await ensureServer();
        expect(r.ok && r.state.port).toBe(old.port);
        expect(r.ok && r.serverVersion).toBeNull();
        expect(r.ok && r.outdated).toBe(true);
      } finally {
        await old.close();
      }
    });

    it('says so on start, with the way to restart', async () => {
      const old = await olderServer();
      try {
        const c = capture();
        expect(await main(['--no-open'], c.out)).toBe(0);
        expect(c.lines.join('\n')).toMatch(/earlier version.*shellyard stop/);
      } finally {
        await old.close();
      }
    });

    it('stopServer asks the server to stop and clears the state file', async () => {
      const old = await olderServer();
      try {
        expect(await stopServer()).toBe('stopped');
        expect(readServerState()).toBeNull();
      } finally {
        await old.close();
      }
    });
  });

  describe('launcher page', () => {
    it('keeps the token off the command line: the browser is given a private file that redirects', () => {
      const file = writeLauncherPage({ pid: 1, port: 7717, token: 'tok123', hookToken: 'h', startedAt: 1 });
      const html = readFileSync(file, 'utf8');
      expect(file).not.toContain('tok123');
      expect(html).toContain('http://127.0.0.1:7717/#token=tok123');
      // In the fragment, the token is never sent to any server, not even ours.
      expect(html).not.toContain('?token=');
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('sends the browser to the page host of this start', () => {
      const pageHost = `${'9'.repeat(32)}.localhost`;
      const html = readFileSync(writeLauncherPage({ pid: 1, port: 7717, pageHost, token: 'tok123', hookToken: 'h', startedAt: 1 }), 'utf8');
      expect(html).toContain(`http://${pageHost}:7717/#token=tok123`);
      expect(html).not.toContain('127.0.0.1');
    });

    it('opens the browser on a new host name at every start', async () => {
      const first = await start();
      const a = readServerState()!.pageHost;
      await first.stop();
      running.length = 0;
      await start();
      const b = readServerState()!.pageHost;
      expect(a).toMatch(/^[0-9a-f]{32}\.localhost$/);
      expect(b).toMatch(/^[0-9a-f]{32}\.localhost$/);
      expect(b).not.toBe(a);
    });
  });

  describe('help and version', () => {
    it('prints the package version', async () => {
      const c = capture();
      expect(await main(['--version'], c.out)).toBe(0);
      expect(c.lines).toEqual([JSON.parse(readFileSync('package.json', 'utf8')).version]);
    });

    it('prints usage', async () => {
      const c = capture();
      expect(await main(['--help'], c.out)).toBe(0);
      expect(c.lines.join('\n')).toMatch(/shellyard stop/);
    });

    it('rejects an unknown command with usage and exit 1', async () => {
      const c = capture();
      expect(await main(['frobnicate'], c.out)).toBe(1);
      expect(c.lines.join('\n')).toMatch(/unknown/i);
    });

    it('rejects a port that is not a number', async () => {
      const c = capture();
      expect(await main(['--port', 'abc', '--no-open'], c.out)).toBe(1);
      expect(readServerState()).toBeNull();
    });
  });
});

describe('the installed command', () => {
  it('is shellyard, and nothing else', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin).toEqual({ shellyard: 'dist/cli/shellyard.js' });
  });
});
