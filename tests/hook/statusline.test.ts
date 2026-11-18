import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve('src/hook/statusline.ts');

function run(env: Record<string, string>, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((done) => {
    const started = Date.now();
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !k.startsWith('SHELLYARD_') && k !== 'CLAUDE_CONFIG_DIR' && k !== 'SHELL') base[k] = v;
    }
    const child = spawn(process.execPath, ['--import', 'tsx', script], { env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });

describe('status-line forwarder', () => {
  let configDir = '';
  beforeEach(() => {
    // Stands in for ~/.claude, so the real one is never read.
    configDir = mkdtempSync(join(tmpdir(), 'shellyard-claude-'));
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  const payload = JSON.stringify({ session_id: 'abc', cost: { total_cost_usd: 1.5 } });

  it('posts the payload to the session with the hook token, and prints nothing when the user has no status line', async () => {
    const received: Array<{ url?: string; token: unknown; body: string }> = [];
    const server = createServer(async (req, res) => {
      received.push({ url: req.url, token: req.headers['x-shellyard-hook-token'], body: await readBody(req) });
      res.writeHead(204).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = String((server.address() as AddressInfo).port);
      const r = await run({ SHELLYARD_PORT: port, SHELLYARD_SESSION_ID: 'abc-123', SHELLYARD_HOOK_TOKEN: 'secret', CLAUDE_CONFIG_DIR: configDir }, payload);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(received).toEqual([{ url: '/api/status/abc-123', token: 'secret', body: payload }]);
    } finally {
      server.close();
    }
  });

  it('runs the user’s own status line with the same input and prints exactly its output', async () => {
    const echo = join(configDir, 'echo.cjs');
    writeFileSync(echo, "let b='';process.stdin.on('data',d=>b+=d).on('end',()=>process.stdout.write('mine:'+JSON.parse(b).session_id))");
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `"${process.execPath}" "${echo}"` } }));
    const r = await run({ SHELLYARD_PORT: '1', SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't', CLAUDE_CONFIG_DIR: configDir }, payload);
    expect(r).toMatchObject({ code: 0, stdout: 'mine:abc', stderr: '' });
  });

  it('stays silent and exits 0 when the user’s status line fails', async () => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'definitely-not-a-command-xyz --flag' } }));
    const r = await run({ SHELLYARD_PORT: '1', SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't', CLAUDE_CONFIG_DIR: configDir }, payload);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  // Claude Code runs status lines with the shell it names in SHELL (Git Bash on Windows).
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const posixShell = process.platform === 'win32' ? gitBash : '/bin/sh';
  const user = (command: string): void => writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }));
  const envFor = (extra: Record<string, string> = {}): Record<string, string> => ({ SHELLYARD_PORT: '1', SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't', CLAUDE_CONFIG_DIR: configDir, SHELL: posixShell, ...extra });

  describe.skipIf(!existsSync(posixShell))('with the shell Claude Code uses', () => {
    it('runs the user’s command in that shell, so shell syntax means what it means in Claude Code', async () => {
      user("printf '%s' 'my status' | tr a-z A-Z");
      expect(await run(envFor(), payload)).toMatchObject({ code: 0, stdout: 'MY STATUS', stderr: '' });
    });

    it('keeps characters that arrive split across chunks intact', async () => {
      const chunks = join(configDir, 'chunks.cjs');
      writeFileSync(chunks, "const b=Buffer.from('€€€');process.stdout.write(b.subarray(0,4));setTimeout(()=>process.stdout.write(b.subarray(4)),150)");
      user(`"${process.execPath.replace(/\\/g, '/')}" "${chunks.replace(/\\/g, '/')}"`);
      expect((await run(envFor(), payload)).stdout).toBe('€€€');
    });

    it('does not run itself in a loop when the user’s status line is this very script', async () => {
      const marker = join(configDir, 'ran.txt');
      user(`echo ran >> "${marker.replace(/\\/g, '/')}"; printf inner`);
      const r = await run(envFor({ SHELLYARD_STATUSLINE: '1' }), payload);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(existsSync(marker)).toBe(false);
    });

    it('marks the command it runs, so a nested copy of itself stops', async () => {
      user('printf "%s" "$SHELLYARD_STATUSLINE"');
      expect((await run(envFor(), payload)).stdout).toBe('1');
    });

    it('gives up on a command that hangs, and leaves no process behind', async () => {
      const pidFile = join(configDir, 'pid.txt');
      const hang = join(configDir, 'hang.cjs');
      writeFileSync(hang, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
      user(`"${process.execPath.replace(/\\/g, '/')}" "${hang.replace(/\\/g, '/')}"`);
      const r = await run(envFor(), payload);
      expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms).toBeLessThan(8000);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await new Promise((res) => setTimeout(res, 500));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) process.kill(pid);
      expect(alive).toBe(false);
    });
  });

  it('survives a settings file that is not valid JSON, a stopped server, and no environment', async () => {
    writeFileSync(join(configDir, 'settings.json'), '{ nope');
    expect(await run({ SHELLYARD_PORT: '1', SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't', CLAUDE_CONFIG_DIR: configDir }, payload)).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await run({ CLAUDE_CONFIG_DIR: configDir }, payload)).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(await run({ CLAUDE_CONFIG_DIR: configDir }, 'not json')).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('does not hang on a server that never answers', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await run({ SHELLYARD_PORT: String((server.address() as AddressInfo).port), SHELLYARD_SESSION_ID: 'abc', SHELLYARD_HOOK_TOKEN: 't', CLAUDE_CONFIG_DIR: configDir }, payload);
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(6000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
