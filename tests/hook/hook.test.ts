import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hookScript = resolve('src/hook/hook.ts');

function runHook(env: Record<string, string>, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((done) => {
    const started = Date.now();
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('TTC_')) base[k] = v;
    }
    const child = spawn(process.execPath, ['--import', 'tsx', hookScript], { env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

describe('hook forwarder', () => {
  it('posts the payload to the session endpoint with the hook token', async () => {
    const received: Array<{ url?: string; method?: string; token: unknown; body: string }> = [];
    const server = createServer(async (req, res) => {
      received.push({ url: req.url, method: req.method, token: req.headers['x-ttc-hook-token'], body: await readBody(req) });
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await runHook(
        { TTC_PORT: String(port), TTC_SESSION_ID: 'abc-123', TTC_HOOK_TOKEN: 'secret' },
        '{"hook_event_name":"Stop"}',
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(received).toEqual([
        { url: '/api/hooks/abc-123', method: 'POST', token: 'secret', body: '{"hook_event_name":"Stop"}' },
      ]);
    } finally {
      server.close();
    }
  });

  it('exits 0 silently and quickly when the server is down', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const result = await runHook(
      { TTC_PORT: String(closedPort), TTC_SESSION_ID: 'abc', TTC_HOOK_TOKEN: 't' },
      '{"hook_event_name":"Stop"}',
    );
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(5000);
  });

  it('exits 0 silently when a server accepts the connection but never answers', async () => {
    const server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await runHook({ TTC_PORT: String(port), TTC_SESSION_ID: 'abc', TTC_HOOK_TOKEN: 't' }, '{}');
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(result.ms).toBeLessThan(6000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('exits 0 silently with no environment at all', async () => {
    const result = await runHook({}, '{"hook_event_name":"Stop"}');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('exits 0 silently when stdin is not JSON', async () => {
    const result = await runHook({ TTC_PORT: '1', TTC_SESSION_ID: 'abc', TTC_HOOK_TOKEN: 't' }, 'not json at all');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
