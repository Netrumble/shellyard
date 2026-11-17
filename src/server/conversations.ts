import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code keeps every conversation as a transcript on disk: one file per conversation,
// one JSON object per line, under <config dir>/projects/<project>/<conversation id>.jsonl.
// That is what lets a conversation be continued in a new process with `claude --resume`.
// The transcript format is not a documented contract, so this reads it defensively: only
// the few fields it needs, skipping anything it does not understand.

export interface Conversation {
  id: string;
  /** The folder the conversation was held in. */
  cwd: string;
  title: string;
  /** When the transcript was last written, in milliseconds. */
  updatedAt: number;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Transcripts can run to many megabytes; the folder and first prompt are near the start. */
const HEAD_BYTES = 256 * 1024;
/** The title is written after the first answer and may be rewritten later: look at the end too. */
const TAIL_BYTES = 256 * 1024;
const MAX_TITLE = 80;
const DEFAULT_LIMIT = 40;

export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

function readSlice(file: string, start: number, length: number): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  return null;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine;
}

/** The last title Claude Code gave the conversation, found in raw text that may start or end mid-line. */
function lastTitle(text: string): string | null {
  const pattern = /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g;
  let found: string | null = null;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) found = m[1]!;
  if (found === null) return null;
  try {
    return JSON.parse(`"${found}"`) as string;
  } catch {
    return null;
  }
}

const cache = new Map<string, { mtimeMs: number; size: number; value: Omit<Conversation, 'id' | 'updatedAt'> | null }>();

/** Reads what is needed of one transcript. Null if nothing was ever asked in it. */
function describe(file: string, mtimeMs: number, size: number): Omit<Conversation, 'id' | 'updatedAt'> | null {
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;

  const head = readSlice(file, 0, Math.min(size, HEAD_BYTES));
  let cwd: string | null = null;
  let prompt: string | null = null;
  for (const line of head.split('\n')) {
    if (cwd !== null && prompt !== null) break;
    if (!line.startsWith('{')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a damaged line, or the last one cut by the read limit
    }
    if (cwd === null && typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
    if (prompt === null && entry.type === 'user' && entry.isSidechain !== true) {
      prompt = promptText((entry.message as { content?: unknown } | undefined)?.content);
    }
  }

  let value: Omit<Conversation, 'id' | 'updatedAt'> | null = null;
  if (prompt !== null && cwd !== null) {
    const tail = size > HEAD_BYTES ? readSlice(file, Math.max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES) : '';
    value = { cwd, title: shorten(lastTitle(tail) ?? lastTitle(head) ?? prompt) };
  }
  cache.set(file, { mtimeMs, size, value });
  return value;
}

export interface TranscriptFile {
  /** The conversation id, which is the file's name. */
  id: string;
  file: string;
  mtimeMs: number;
  size: number;
}
type Found = TranscriptFile;

/** Every conversation transcript under Claude Code's projects folder. */
export function listTranscriptFiles(dir: string = claudeProjectsDir()): TranscriptFile[] {
  return transcripts(dir);
}

/** The same listing without blocking: used by the background reading of costs. */
export async function listTranscriptFilesAsync(dir: string = claudeProjectsDir()): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  let projects: string[];
  try {
    projects = await readdir(dir);
  } catch {
    return found;
  }
  for (const project of projects) {
    let names: string[];
    try {
      names = await readdir(join(dir, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!ID_PATTERN.test(id)) continue;
      const file = join(dir, project, name);
      try {
        const s = await stat(file);
        if (s.isFile()) found.push({ id, file, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // gone between listing and reading
      }
    }
  }
  return found;
}

function transcripts(dir: string): Found[] {
  const found: Found[] = [];
  let projects: string[];
  try {
    projects = readdirSync(dir);
  } catch {
    return found; // Claude Code has never run here
  }
  for (const project of projects) {
    let names: string[];
    try {
      names = readdirSync(join(dir, project));
    } catch {
      continue; // a file, or a folder that cannot be read
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!ID_PATTERN.test(id)) continue;
      const file = join(dir, project, name);
      try {
        const s = statSync(file);
        if (s.isFile()) found.push({ id, file, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        // gone between listing and reading
      }
    }
  }
  return found;
}

function toConversation(t: Found): Conversation | null {
  try {
    const d = describe(t.file, t.mtimeMs, t.size);
    return d ? { id: t.id, cwd: d.cwd, title: d.title, updatedAt: t.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The most recently used conversations, newest first. */
export function listConversations(opts: { dir?: string; limit?: number } = {}): Conversation[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const all = transcripts(opts.dir ?? claudeProjectsDir()).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: Conversation[] = [];
  for (const t of all) {
    if (out.length >= limit) break;
    const c = toConversation(t);
    if (c) out.push(c);
  }
  return out;
}

/** One conversation by its id, or null if there is no such transcript to resume. */
export function findConversation(id: string, dir: string = claudeProjectsDir()): Conversation | null {
  if (!ID_PATTERN.test(id)) return null;
  const t = transcripts(dir).find((x) => x.id.toLowerCase() === id.toLowerCase());
  return t ? toConversation(t) : null;
}
