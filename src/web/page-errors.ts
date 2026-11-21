import type { ErrorReport } from '../shared/types.js';
import { api } from './api.js';

/** The same error is sent again only after this long. */
const RESEND_MS = 30_000;
/** At most this many reports from one page: a loop of errors must not flood the server. */
const MAX_SENT = 30;

/**
 * Noise every browser makes, which is no fault of ShellYard: a resize observer that could not
 * deliver everything in one frame, and errors from other origins (extensions), which the browser
 * hides behind "Script error.".
 */
export function isNoise(message: string, filename?: string): boolean {
  if (/ResizeObserver loop/i.test(message)) return true;
  if (message === 'Script error.' || message === 'Script error') return true;
  return !!filename && /^(chrome|moz|safari)(-web)?-extension:/.test(filename);
}

/** The message and stack of whatever was thrown or rejected. */
export function describeThrown(thrown: unknown, fallback: string): { message: string; stack: string | null } {
  if (thrown instanceof Error) return { message: `${thrown.name}: ${thrown.message}`, stack: thrown.stack ?? null };
  if (thrown === undefined || thrown === null) return { message: fallback, stack: null };
  return { message: typeof thrown === 'string' ? thrown : String(thrown), stack: null };
}

/** Decides which page errors are sent: each at most once in a while, and not too many in all. */
export class SendGate {
  private readonly last = new Map<string, number>();
  private sent = 0;

  allow(message: string, now: number): boolean {
    if (this.sent >= MAX_SENT) return false;
    const before = this.last.get(message);
    if (before !== undefined && now - before < RESEND_MS) return false;
    this.last.set(message, now);
    this.sent++;
    return true;
  }
}

const gate = new SendGate();

/** Sends an error of the page to the server, which writes its report; resolves with it, or null. */
export async function reportPageError(thrown: unknown, context: string, fallback = 'Unknown error'): Promise<ErrorReport | null> {
  const { message, stack } = describeThrown(thrown, fallback);
  if (isNoise(message) || !gate.allow(message, Date.now())) return null;
  try {
    return await api.reportError({ message, stack, context });
  } catch {
    // The server is down or refuses: there is nowhere to write it, and nothing more to do.
    return null;
  }
}

/** Reports every error nothing in the page caught. `where` says what the page was showing. */
export function installPageErrorReporting(where: () => string): void {
  window.addEventListener('error', (e) => {
    if (isNoise(e.message, e.filename)) return;
    void reportPageError(e.error ?? e.message, `page: ${where()}`, e.message || 'Unknown error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    void reportPageError(e.reason, `page: ${where()} (unhandled promise rejection)`, 'A promise was rejected');
  });
}

/** How long a known error must have been quiet for its return to be told again. */
export const QUIET_MS = 60_000;

/**
 * The errors to tell the user about: new ones, and known ones that came back, unseen, after a
 * quiet minute at least. An error that repeats without pause is told once; its count goes on.
 */
export function freshErrors(prev: ErrorReport[], next: ErrorReport[]): ErrorReport[] {
  const before = new Map(prev.map((r) => [r.id, r]));
  return next.filter((r) => {
    if (r.seen) return false;
    const old = before.get(r.id);
    return !old || (r.count > old.count && r.lastAt - old.lastAt >= QUIET_MS);
  });
}
