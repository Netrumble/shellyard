import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Conversation, SessionInfo, SessionKind, TerminalBackground, TerminalFont } from '../shared/types.js';
import { normalizeBackground } from './backgrounds.js';
import { normalizeFont } from './fonts.js';
import type { SessionManager } from './session-manager.js';

// What was open when the server stopped, so that it can be brought back at the next start.
// Processes cannot outlive the server, but a Claude Code conversation is on disk and can be
// resumed, and a shell can at least be reopened in the same folder under the same name.

export interface RestoreEntry {
  kind: SessionKind;
  profileId: string | null;
  name: string;
  color: string;
  cwd: string;
  command: string;
  args: string[];
  storyId: string | null;
  /** The model the session was asked to start with, if any. */
  model: string | null;
  /** For a Claude session, the conversation it was holding. */
  conversationId: string | null;
  /** The terminal background it had; absent in lists saved before backgrounds existed. */
  background?: TerminalBackground | null;
  /** The font it had; absent in lists saved before fonts could be chosen. */
  font?: TerminalFont | null;
}

const FILE_VERSION = 1;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function toEntry(v: unknown): RestoreEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const name = str(o.name);
  const cwd = str(o.cwd);
  const command = str(o.command);
  if (!name || !cwd || !command) return null;
  return {
    kind: o.kind === 'claude' ? 'claude' : 'shell',
    profileId: str(o.profileId),
    name,
    color: str(o.color) ?? '#888888',
    cwd,
    command,
    args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === 'string') : [],
    storyId: str(o.storyId),
    model: str(o.model),
    conversationId: str(o.conversationId),
    background: normalizeBackground(o.background),
    font: normalizeFont(o.font),
  };
}

/** The saved list; empty if there is none or it cannot be read. */
export function loadRestorable(file: string): RestoreEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const list = (raw as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(list)) return [];
    return list.map(toEntry).filter((e): e is RestoreEntry => e !== null);
  } catch {
    return [];
  }
}

export function saveRestorable(file: string, entries: RestoreEntry[]): void {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, sessions: entries }, null, 1));
    renameSync(tmp, file);
  } catch {
    // Not being able to save this list must not disturb the sessions that are running.
  }
}

/**
 * Starts again the session an entry describes. A Claude session resumes its conversation if
 * the transcript is there; if it never got as far as having one, it starts fresh.
 */
export function reopenEntry(manager: SessionManager, e: RestoreEntry, findConversation: (id: string) => Conversation | null): SessionInfo {
  const resume = e.kind === 'claude' && e.conversationId && findConversation(e.conversationId) ? e.conversationId : undefined;
  const known = manager.profiles().some((p) => p.id === e.profileId);
  return manager.create({
    kind: e.kind,
    // A profile deleted in the meantime is not a reason to lose the session.
    profileId: e.profileId && known ? e.profileId : undefined,
    command: e.command,
    args: e.args,
    name: e.name,
    color: e.color,
    cwd: e.cwd,
    storyId: e.storyId,
    model: e.model,
    resume,
    // What the session looked like is part of what comes back.
    background: e.background ?? null,
    font: e.font ?? null,
  });
}

/** Starts again everything a saved list describes. */
export function restoreSessions(manager: SessionManager, entries: RestoreEntry[], findConversation: (id: string) => Conversation | null): void {
  for (const e of entries) reopenEntry(manager, e, findConversation);
}
