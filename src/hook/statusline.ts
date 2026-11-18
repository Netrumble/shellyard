// Run by Claude Code as the status-line command of a session started by ShellYard. Claude Code
// hands it a JSON payload (plan limits, cost and tokens of the session, model in use) on
// stdin. This forwards the payload to the local ShellYard server and stands aside: whatever the
// user's own status line would print is printed, unchanged. Like the hook forwarder it must
// never disturb the session: exit 0 whatever happens, nothing on stderr.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USER_LINE_TIMEOUT_MS = 3000;
/** Set on the command this runs, so that a copy of this script reached through it stops. */
const NESTED = 'SHELLYARD_STATUSLINE';

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function forward(body: Buffer): Promise<void> {
  const port = process.env.SHELLYARD_PORT;
  const sessionId = process.env.SHELLYARD_SESSION_ID;
  const token = process.env.SHELLYARD_HOOK_TOKEN;
  if (!port || !sessionId || !token) return;
  await fetch(`http://127.0.0.1:${port}/api/status/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shellyard-hook-token': token },
    body: body.toString('utf8'),
    signal: AbortSignal.timeout(2000),
  });
}

/** The status-line command from the user's own Claude Code settings, if they have one. */
function userCommand(): string | null {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settings: unknown = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    const line = (settings as { statusLine?: { command?: unknown } } | null)?.statusLine;
    return typeof line?.command === 'string' && line.command.trim() ? line.command : null;
  } catch {
    return null;
  }
}

/**
 * A program of Windows itself, by full path. This script runs in the folder of a Claude Code
 * session, and a bare name ("taskkill") is looked up in the current folder first: a program of
 * that name in the project would run instead.
 */
function systemProgram(name: string): string {
  return join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name);
}

/** Ends the command and everything it started; killing only the shell leaves its children. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // Waited for: this script exits right after, and the kill must have happened by then.
    if (process.platform === 'win32') execFileSync(systemProgram('taskkill.exe'),['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 2000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill();
  }
}

/**
 * Runs the user's status-line command the way Claude Code does: in the shell Claude Code
 * names in SHELL (Git Bash on Windows), so that quoting, pipes and ~ mean the same here.
 * Prints nothing if the command fails or takes too long.
 */
function runUserLine(command: string, body: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (out: Buffer): void => {
      if (done) return;
      done = true;
      resolve(out);
    };
    try {
      const env = { ...process.env, [NESTED]: '1' };
      const shell = process.env.SHELL || (process.platform === 'win32' ? null : '/bin/sh');
      const child = shell
        ? spawn(shell, ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env, detached: process.platform !== 'win32' })
        : spawn(command, { shell: systemProgram('cmd.exe'), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env });
      const timer = setTimeout(() => {
        killTree(child);
        finish(Buffer.alloc(0));
      }, USER_LINE_TIMEOUT_MS);
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.on('error', () => {
        clearTimeout(timer);
        finish(Buffer.alloc(0));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Bytes are joined before decoding: a character may arrive split across two chunks.
        finish(code === 0 ? Buffer.concat(chunks) : Buffer.alloc(0));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(body);
    } catch {
      finish(Buffer.alloc(0));
    }
  });
}

async function main(): Promise<void> {
  // Reached through the command this script itself ran: do nothing, or it would never end.
  if (process.env[NESTED]) return;
  const body = await readStdin();
  const command = userCommand();
  const forwarding = forward(body).catch(() => undefined);
  // The user's line is printed as soon as it is ready; a slow server must not hold it back.
  if (command) {
    const line = await runUserLine(command, body);
    if (line.length > 0) await new Promise<void>((r) => process.stdout.write(line, () => r()));
  }
  await forwarding;
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
