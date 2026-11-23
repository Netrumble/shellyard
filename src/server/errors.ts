import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import type { ErrorReport, ErrorSource } from '../shared/types.js';

// Unexpected errors, each written to a file of its own in ~/.shellyard/errors/, so that the user
// is told where it is and can read it or attach it to an issue. Expected refusals (git turning a
// branch down, a session that cannot start) are not errors here: they say so where they happen.
//
// A report never holds a secret ShellYard knows of: the tokens and the page's host name are taken
// out of every line, and so is anything that looks like a token.

/** How many report files are kept; the oldest go first. */
export const KEEP_FILES = 50;
/** At most this many new reports a minute; a storm of errors must not fill the disk. */
export const PER_MINUTE = 20;
/** How many times a repeated error is noted in its file. */
const MAX_AGAIN = 100;
const MAX_MESSAGE = 1000;
const MAX_STACK = 20_000;
const MAX_CONTEXT = 300;
/** A token as ShellYard makes them: 32 random bytes in hex. */
const TOKEN_LIKE = /\b[0-9a-f]{64}\b/gi;
/** The label of a page's host name as ShellYard makes them (16 random bytes in hex), before .localhost. */
const PAGE_HOST_LIKE = /\b[0-9a-f]{32}(?=\.localhost\b)/gi;
/** How often, at most, a repeated error tells the listeners (the page) again. */
export const REPEAT_EMIT_MS = 5000;

/**
 * The folder of the reports. It is not made here: a report makes it when it is written, so that a
 * folder that cannot be made costs the reports only, never the start of the server.
 */
export function errorsDir(home: string): string {
  return join(home, 'errors');
}

/** Takes every secret out of a text. Secrets shorter than 8 characters are not secrets worth the name. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('[redacted]');
  // Page host names are taken out whatever the secrets given: a report written by another process
  // (the CLI, at a start that timed out) knows none, yet the log tail may name the page's host.
  return out.replace(TOKEN_LIKE, '[redacted]').replace(PAGE_HOST_LIKE, '[redacted]');
}

/** The first line of an error and its stack, whatever was thrown. */
export function errorParts(e: unknown): { message: string; stack: string | null } {
  if (e instanceof Error) {
    const head = `${e.name}: ${e.message}`;
    return { message: head.split('\n')[0]!, stack: e.stack ?? null };
  }
  const text = typeof e === 'string' ? e : (() => {
    try {
      return JSON.stringify(e) ?? String(e);
    } catch {
      return String(e);
    }
  })();
  return { message: text.split('\n')[0]!, stack: null };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (cut)` : text;
}

/** A file name that sorts by time: 2026-11-21T15-30-12-345Z-a1b2c3d4.log. */
function fileName(at: number, id: string): string {
  return `${new Date(at).toISOString().replace(/:/g, '-').replace('.', '-')}-${id}.log`;
}

export interface ReportInput {
  source: ErrorSource;
  error: unknown;
  context?: string | null;
  /** A stack the page sent, instead of the one of `error`. */
  stack?: string | null;
}

export interface ReporterDeps {
  dir: string;
  now: () => number;
  version: string;
  /** The secrets of this run, taken out of every report. */
  secrets?: () => string[];
  /** The last lines of the server log, added at the end of a report. */
  logTail?: () => string;
  keep?: number;
  perMinute?: number;
  /** See REPEAT_EMIT_MS. */
  repeatEmitMs?: number;
}

/** Writes and keeps the error reports of one run of the server. */
export class ErrorReporter {
  private reports: ErrorReport[] = [];
  private readonly byKey = new Map<string, ErrorReport>();
  private recent: number[] = [];
  private readonly cbs: Array<(list: ErrorReport[]) => void> = [];
  private lastEmit = -Infinity;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ReporterDeps) {}

  onChange(cb: (list: ErrorReport[]) => void): void {
    this.cbs.push(cb);
  }

  /** Newest first. */
  list(): ErrorReport[] {
    return this.reports.map((r) => ({ ...r }));
  }

  get(id: string): ErrorReport | null {
    const r = this.reports.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  private emit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.lastEmit = this.deps.now();
    const list = this.list();
    for (const cb of this.cbs) cb(list);
  }

  /**
   * Tells the listeners of a repetition, but not more than once every REPEAT_EMIT_MS: an error
   * that comes back every second must not become a broadcast every second.
   */
  private emitSoon(): void {
    if (this.emitTimer) return;
    const wait = this.lastEmit + (this.deps.repeatEmitMs ?? REPEAT_EMIT_MS) - this.deps.now();
    if (wait <= 0) return this.emit();
    this.emitTimer = setTimeout(() => this.emit(), wait);
    this.emitTimer.unref?.();
  }

  /** Stops a pending notice of repetitions; the reporter can still be used. */
  dispose(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  /** Marks a report as seen (its notice closed); false when there is no such report. */
  dismiss(id: string): boolean {
    const r = this.reports.find((x) => x.id === id);
    if (!r) return false;
    if (!r.seen) {
      r.seen = true;
      this.emit();
    }
    return true;
  }

  dismissAll(): void {
    let changed = false;
    for (const r of this.reports) {
      if (!r.seen) changed = r.seen = true;
    }
    if (changed) this.emit();
  }

  /**
   * Writes a report for an unexpected error and returns it. The same error again in this run
   * is noted in its file and counted, not written anew. Null when nothing could be written, or
   * when too many errors came in the last minute.
   */
  report(input: ReportInput): ErrorReport | null {
    const secrets = this.deps.secrets?.() ?? [];
    const now = this.deps.now();
    const parts = errorParts(input.error);
    const message = cut(redact(parts.message, secrets), MAX_MESSAGE);
    const stack = input.stack !== undefined ? input.stack : parts.stack;
    const context = input.context ? cut(redact(input.context, secrets), MAX_CONTEXT) : null;
    const firstFrame = (stack ?? '').split('\n').find((l) => /^\s+at /.test(l))?.trim() ?? '';
    const key = `${input.source}\n${message}\n${context ?? ''}\n${firstFrame}`;

    const known = this.byKey.get(key);
    if (known) {
      known.count++;
      known.lastAt = now;
      known.seen = false;
      if (known.count <= MAX_AGAIN) {
        try {
          appendFileSync(known.file, `Again at ${new Date(now).toISOString()} (${known.count} times in all)\n`);
        } catch {
          // The file is gone or cannot be written: the count on the page still says it.
        }
      }
      this.reports = [known, ...this.reports.filter((r) => r !== known)];
      this.emitSoon();
      return { ...known };
    }

    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= (this.deps.perMinute ?? PER_MINUTE)) return null;
    this.recent.push(now);

    const id = randomBytes(4).toString('hex');
    const file = join(this.deps.dir, fileName(now, id));
    const text = [
      'ShellYard error report',
      '',
      `When:     ${new Date(now).toISOString()}`,
      `Where:    ${input.source}`,
      `Context:  ${context ?? '-'}`,
      `Version:  ShellYard ${this.deps.version}, Node ${process.version}, ${platform()} ${release()} ${arch()}`,
      '',
      `Message:  ${message}`,
      '',
      'Stack:',
      stack ? cut(redact(stack, secrets), MAX_STACK) : '(none)',
      '',
      ...(this.deps.logTail ? ['Last lines of shellyard.log:', redact(this.deps.logTail(), secrets) || '(empty)', ''] : []),
      '',
    ].join('\n');
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
    } catch {
      return null;
    }
    this.prune();

    const report: ErrorReport = { id, source: input.source, message, context, file, at: now, count: 1, lastAt: now, seen: false };
    this.byKey.set(key, report);
    this.reports = [report, ...this.reports].slice(0, this.deps.keep ?? KEEP_FILES);
    // A report dropped from the list is not counted again under its old entry.
    for (const [k, r] of this.byKey) if (!this.reports.includes(r)) this.byKey.delete(k);
    this.emit();
    return { ...report };
  }

  /** Keeps the newest report files only. */
  private prune(): void {
    try {
      const files = readdirSync(this.deps.dir)
        .filter((f) => f.endsWith('.log'))
        .sort();
      const extra = files.length - (this.deps.keep ?? KEEP_FILES);
      for (let i = 0; i < extra; i++) rmSync(join(this.deps.dir, files[i]!), { force: true });
    } catch {
      // Old reports left behind are harmless.
    }
  }
}

/**
 * The program and arguments that show a file in the system's file manager, selected where the
 * manager can do that. Windows programs are named by full path, never looked up.
 */
export function revealCommand(file: string, os: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; verbatim: boolean } {
  if (os === 'darwin') return { file: '/usr/bin/open', args: ['-R', file], verbatim: false };
  if (os === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    // Explorer reads "/select," and the quoted path as one argument, exactly as written.
    return { file: win32.join(root, 'explorer.exe'), args: [`/select,"${file}"`], verbatim: true };
  }
  return { file: 'xdg-open', args: [dirname(file)], verbatim: false };
}
