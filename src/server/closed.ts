import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ClosedSession } from '../shared/types.js';
import { normalizeBackground } from './backgrounds.js';
import { normalizeFont } from './fonts.js';
import type { RestoreEntry } from './restore.js';

// Sessions that have ended or were closed, kept so that they can be opened again from their
// area: a Claude session on the conversation it was holding, a shell in the same folder under
// the same name. This is the user's history of closed sessions; the sessions that were open
// when the server stopped are a different list, and come back by themselves.

interface Stored extends RestoreEntry {
  id: string;
  /** The session this came from, so that its leftover entry can be cleared on reopening. */
  sessionId: string;
  closedAt: number;
}

const FILE_VERSION = 1;
const MAX_ENTRIES = 50;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function toStored(v: unknown): Stored | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  const cwd = str(o.cwd);
  const command = str(o.command);
  if (!id || !name || !cwd || !command) return null;
  return {
    id,
    sessionId: str(o.sessionId) ?? '',
    closedAt: typeof o.closedAt === 'number' && Number.isFinite(o.closedAt) ? o.closedAt : 0,
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

function toPublic(s: Stored): ClosedSession {
  return {
    id: s.id,
    sessionId: s.sessionId,
    closedAt: s.closedAt,
    kind: s.kind,
    name: s.name,
    color: s.color,
    cwd: s.cwd,
    storyId: s.storyId,
    resumes: s.kind === 'claude' && s.conversationId !== null,
  };
}

export class ClosedStore {
  private entries: Stored[];
  private readonly changeCbs: Array<(closed: ClosedSession[]) => void> = [];

  constructor(private readonly deps: { file: string; now: () => number }) {
    this.entries = this.load();
  }

  private load(): Stored[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.deps.file, 'utf8'));
      const list = (raw as { closed?: unknown } | null)?.closed;
      if (!Array.isArray(list)) return [];
      return list.map(toStored).filter((e): e is Stored => e !== null).slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private changed(): void {
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, closed: this.entries }, null, 1));
      renameSync(tmp, this.deps.file);
    } catch {
      // The history of closed sessions is a convenience; the running ones matter more.
    }
    const list = this.list();
    for (const cb of this.changeCbs) cb(list);
  }

  /** Newest first. */
  list(): ClosedSession[] {
    return this.entries.map(toPublic);
  }

  add(entry: RestoreEntry, sessionId: string): ClosedSession {
    const stored: Stored = { ...entry, id: randomUUID(), sessionId, closedAt: this.deps.now() };
    // A conversation is one thing to reopen, however many times it was closed.
    const rest = stored.conversationId ? this.entries.filter((e) => e.conversationId !== stored.conversationId) : this.entries;
    this.entries = [stored, ...rest].slice(0, MAX_ENTRIES);
    this.changed();
    return toPublic(stored);
  }

  /** Takes an entry out of the list to reopen it. */
  take(id: string): Stored | null {
    const found = this.entries.find((e) => e.id === id);
    if (!found) return null;
    this.entries = this.entries.filter((e) => e !== found);
    this.changed();
    return found;
  }

  /** Puts back an entry that could not be reopened after all. */
  putBack(entry: Stored): void {
    this.entries = [entry, ...this.entries].sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_ENTRIES);
    this.changed();
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.changed();
    return true;
  }

  onChange(cb: (closed: ClosedSession[]) => void): void {
    this.changeCbs.push(cb);
  }
}
