import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_NAMES, type HookName } from '../shared/types.js';
import { runDir } from './config.js';

export interface ClaudeLaunchInput {
  sessionId: string;
  port: number;
  hookToken: string;
  model: string | null;
  hookScriptPath: string;
  statusScriptPath: string;
  extraArgs: string[];
  /** A saved conversation to continue; without it a new one is started under sessionId. */
  resumeId?: string | null;
  /** The id of a new conversation; defaults to sessionId. The settings file and hooks still use sessionId. */
  conversationId?: string;
}

export interface ClaudeLaunchOutput {
  args: string[];
  env: Record<string, string>;
  settingsPath: string;
}

function settingsPathFor(sessionId: string): string {
  return join(runDir(), `${sessionId}.settings.json`);
}

/**
 * Builds what a Claude Code session needs to report its state to ShellYard. The hooks go in a
 * settings file of ShellYard's own, passed with --settings, so the user's Claude settings are
 * never modified; Claude Code adds these hooks to whatever the user already has.
 */
export function prepareClaudeLaunch(i: ClaudeLaunchInput): ClaudeLaunchOutput {
  const settingsPath = settingsPathFor(i.sessionId);
  // The Node running ShellYard, by full path: "node" on PATH may be another version or absent.
  const command = `"${process.execPath}" "${i.hookScriptPath}"`;
  const hooks: Record<string, unknown> = {};
  for (const name of HOOK_NAMES) hooks[name] = [{ hooks: [{ type: 'command', command }] }];
  // Claude Code hands its status payload (plan limits, cost, tokens, model) to this command.
  // It forwards the payload to ShellYard and then prints what the user's own status line prints.
  const statusLine = { type: 'command', command: `"${process.execPath}" "${i.statusScriptPath}"` };
  writeFileSync(settingsPath, JSON.stringify({ hooks, statusLine }, null, 2));

  return {
    settingsPath,
    args: [
      '--settings',
      settingsPath,
      ...(i.resumeId ? ['--resume', i.resumeId] : ['--session-id', i.conversationId ?? i.sessionId]),
      ...(i.model ? ['--model', i.model] : []),
      ...i.extraArgs,
    ],
    env: {
      SHELLYARD_SESSION_ID: i.sessionId,
      SHELLYARD_PORT: String(i.port),
      SHELLYARD_HOOK_TOKEN: i.hookToken,
    },
  };
}

export function cleanupClaudeLaunch(sessionId: string): void {
  try {
    rmSync(settingsPathFor(sessionId), { force: true });
  } catch {
    // A leftover settings file is harmless.
  }
}

function isHookName(v: unknown): v is HookName {
  return typeof v === 'string' && (HOOK_NAMES as readonly string[]).includes(v);
}

/**
 * Reads a hook payload. A notification counts as an idle reminder ("Claude is waiting for
 * your input", sent after a while of inactivity) only when it clearly is one; anything
 * that cannot be classified is treated as a real request for the user.
 */
export function parseHookBody(body: unknown): { name: HookName; idleReminder: boolean } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!isHookName(b.hook_event_name)) return null;
  let idleReminder = false;
  if (b.hook_event_name === 'Notification') {
    if (typeof b.notification_type === 'string') idleReminder = b.notification_type === 'idle_prompt';
    else idleReminder = typeof b.message === 'string' && /waiting for your input/i.test(b.message);
  }
  return { name: b.hook_event_name, idleReminder };
}

/**
 * Environment variables that mark a process as running inside another Claude Code session.
 * If ShellYard itself was started from a Claude Code terminal they would leak into every session
 * it hosts, and Claude Code then treats those as child sessions (for one thing, it stops
 * saving their transcripts).
 */
export function withoutClaudeSessionMarkers(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|EXECPATH))$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
