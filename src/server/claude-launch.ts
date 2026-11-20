import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_NAMES, type HookName, type PendingRequest } from '../shared/types.js';
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

/** What a hook says the session is asking for; the id and the time are the manager's. */
export type HookRequest = Omit<PendingRequest, 'id' | 'since'>;

const DETAIL_MAX = 500;

/** Text fit to show: one piece, no control characters, at most DETAIL_MAX characters. */
function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = v.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
  if (!text) return null;
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/** The one thing a tool would act on: the command, the file, the address; else its input in short. */
function detailOf(tool: string | null, input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const i = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path']) {
    if (key in i) return clean(i[key]);
  }
  if (tool === 'Bash') return null;
  try {
    return clean(JSON.stringify(i));
  } catch {
    return null;
  }
}

/** The first question of an AskUserQuestion input, fit to show. */
function firstQuestion(input: unknown): string | null {
  const questions = (input as { questions?: unknown } | null)?.questions;
  return clean(Array.isArray(questions) ? (questions[0] as { question?: unknown } | undefined)?.question : undefined);
}

/** Tools whose permission menu opens on "Yes" (allow once) and is refused with Escape. */
const PLAIN_YES_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);

/**
 * Whether Enter on the menu of this tool means "allow once" and nothing more. MCP tools ask the
 * same way. Anything else (plan approval, questions, tools ShellYard does not know) is not
 * answered by pressing keys blind.
 */
export function plainYesMenu(tool: string | null): boolean {
  if (!tool) return false;
  return PLAIN_YES_TOOLS.has(tool) || /^mcp__[\w-]+__[\w-]+$/.test(tool);
}

/**
 * The Bash command of a permission request exactly as Claude Code sent it: what an area rule is
 * checked against and made from. Never shown as is (see parseHookRequest for that).
 */
export function permissionCommand(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.hook_event_name !== 'PermissionRequest' || b.tool_name !== 'Bash') return null;
  const command = (b.tool_input as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : null;
}

/**
 * Reads what a blocked session asks, from the hooks that say it: a permission request (with
 * the tool and its input), a notification (its message; the idle reminder asks nothing), or a
 * question Claude is about to put (PreToolUse of AskUserQuestion). Null for anything else.
 */
export function parseHookRequest(body: unknown): HookRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const tool = typeof b.tool_name === 'string' ? clean(b.tool_name) : null;
  switch (b.hook_event_name) {
    case 'PermissionRequest':
      // Only a menu that opens on a plain "Yes" can be answered from outside: anything else
      // (ExitPlanMode, AskUserQuestion, a tool we do not know) is shown as a question.
      return {
        kind: plainYesMenu(tool) ? 'permission' : 'question',
        tool,
        detail: tool === 'AskUserQuestion' ? firstQuestion(b.tool_input) : detailOf(tool, b.tool_input),
        message: null,
      };
    case 'Notification': {
      if (parseHookBody(b)?.idleReminder) return null;
      const message = clean(b.message);
      if (b.notification_type === 'permission_prompt' || (message !== null && /permission/i.test(message))) {
        const named = message ? /permission to use ([\w.-]+)/i.exec(message) : null;
        const namedTool = named ? named[1]! : null;
        return { kind: plainYesMenu(namedTool) ? 'permission' : 'question', tool: namedTool, detail: null, message };
      }
      return { kind: 'question', tool: null, detail: null, message };
    }
    case 'PreToolUse':
      if (tool !== 'AskUserQuestion') return null;
      return { kind: 'question', tool, detail: firstQuestion(b.tool_input), message: null };
    default:
      return null;
  }
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
