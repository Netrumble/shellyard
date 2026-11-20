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
      if (v !== undefined && !k.startsWith('SHELLYARD_')) base[k] = v;
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
      received.push({ url: req.url, method: req.method, token: req.headers['x-shellyard-hook-token'], body: await readBody(req) });
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await runHook(
        { SHELLYARD_PORT: String(port), SHELLYARD_SESSION_ID: 'abc-123', SHELLYARD_HOOK_TOKEN: 'secret' },
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
      { SHELLYARD_PORT: String(closedPort), SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't' },
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
      const result = await runHook({ SHELLYARD_PORT: String(port), SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't' }, '{}');
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
    const result = await runHook({ SHELLYARD_PORT: '1', SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't' }, 'not json at all');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  /** A server that answers every hook with this status and body. */
  async function answering(status: number, body: string): Promise<{ port: number; close: () => void }> {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as AddressInfo).port, close: () => server.close() };
  }
  const env = (port: number) => ({ SHELLYARD_PORT: String(port), SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't' });
  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  const permission = '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"dotnet test"}}';

  it('prints the allow an area rule gave a permission request, for Claude Code to read', async () => {
    const s = await answering(200, allow);
    try {
      const result = await runHook(env(s.port), permission);
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toEqual(JSON.parse(allow));
    } finally {
      s.close();
    }
  });

  it('prints nothing for anything but an allow of a permission request', async () => {
    const cases: Array<[number, string, string]> = [
      [204, '', permission],
      [200, allow, '{"hook_event_name":"PreToolUse"}'],
      [200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } }), permission],
      [200, JSON.stringify({ decision: 'approve' }), permission],
      [200, 'not json', permission],
      [500, allow, permission],
    ];
    for (const [status, body, stdin] of cases) {
      const s = await answering(status, body);
      try {
        const result = await runHook(env(s.port), stdin);
        expect(result, `${status} ${body} for ${stdin}`).toMatchObject({ code: 0, stdout: '', stderr: '' });
      } finally {
        s.close();
      }
    }
  });
});
