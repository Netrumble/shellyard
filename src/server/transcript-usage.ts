import { open } from 'node:fs/promises';
import { listTranscriptFilesAsync } from './conversations.js';
import type { CostSpan, FileState, ModelTotals, ScannedAmount, UsageStore } from './usage.js';

// What Claude Code costs is read from its own transcripts. After every turn it writes a
// "cost-state" line holding the running totals of the conversation, per model: its own
// estimate of the cost, and the tokens. The difference between two such lines is what the
// turn in between cost, and the message line before it says when. Reading the transcripts
// covers every Claude Code session on the machine, in whatever window it runs, which is
// what "today's cost" has to mean.
//
// Transcripts grow to many megabytes, so each is read once and then only where it has grown,
// a bounded amount at a time. The format is not a documented contract: lines that are not
// understood are skipped.

const COST_MARK = '"type":"cost-state"';
const TIME_MARK = '"timestamp":"';
/** Transcripts not written for longer than the longest period shown are not worth reading. */
const MAX_AGE_MS = 31 * 24 * 3600 * 1000;
const MAX_TOTAL_COST = 1e6;
const MAX_TOTAL_TOKENS = 1e13;
const MAX_MODEL_ID = 100;
/** A single line can be longer than one step; the read grows up to this to get past it. */
const MAX_READ_BYTES = 64 * 1024 * 1024;

export function emptyFileState(): FileState {
  return { offset: 0, lastAt: 0, models: Object.create(null) as Record<string, ModelTotals> };
}

const num = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);

function totalsOf(v: unknown): ModelTotals | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const costUsd = num(o.costUSD, MAX_TOTAL_COST);
  const input = num(o.inputTokens, MAX_TOTAL_TOKENS);
  const output = num(o.outputTokens, MAX_TOTAL_TOKENS);
  if (costUsd === null || input === null || output === null) return null;
  // Reading from and writing to the prompt cache is input too.
  const cached = (num(o.cacheReadInputTokens, MAX_TOTAL_TOKENS) ?? 0) + (num(o.cacheCreationInputTokens, MAX_TOTAL_TOKENS) ?? 0);
  return { costUsd, tokensIn: input + cached, tokensOut: output };
}

/** The time on a message line, read without parsing the line (which may be very long). */
function timeOf(line: string): number | null {
  const i = line.lastIndexOf(TIME_MARK);
  if (i < 0) return null;
  const t = Date.parse(line.slice(i + TIME_MARK.length, i + TIME_MARK.length + 24));
  return Number.isNaN(t) ? null : t;
}

/**
 * Reads complete transcript lines, continuing from an earlier state. Returns what was spent
 * in them and the state to continue from. `fallbackAt` dates amounts found before any
 * message line.
 */
export function scanText(
  text: string,
  prev: FileState,
  fallbackAt: number,
): { state: FileState; amounts: ScannedAmount[]; spans: CostSpan[] } {
  const models = Object.assign(Object.create(null) as Record<string, ModelTotals>, prev.models);
  let lastAt = prev.lastAt;
  const amounts: ScannedAmount[] = [];
  /** For each amount, how the step it came from moved the conversation's running cost. */
  const spans: CostSpan[] = [];
  const totalCost = (): number => Object.values(models).reduce((sum, m) => sum + m.costUsd, 0);

  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;

    // The marker must be near the start: a line merely quoting it inside its content is not one.
    const mark = line.indexOf(COST_MARK);
    if (mark >= 0 && mark < 8) {
      let usage: unknown;
      try {
        usage = (JSON.parse(line) as { modelUsage?: unknown }).modelUsage;
      } catch {
        continue;
      }
      if (typeof usage !== 'object' || usage === null) continue;
      const before = totalCost();
      const firstOfStep = amounts.length;
      for (const [id, raw] of Object.entries(usage)) {
        const now = totalsOf(raw);
        if (!now || !id || id.length > MAX_MODEL_ID) continue;
        const was = models[id] ?? { costUsd: 0, tokensIn: 0, tokensOut: 0 };
        // A total lower than the last one is a count that started again from zero.
        const step = (a: number, b: number): number => (a >= b ? a - b : a);
        const delta = { costUsd: step(now.costUsd, was.costUsd), tokensIn: step(now.tokensIn, was.tokensIn), tokensOut: step(now.tokensOut, was.tokensOut) };
        models[id] = now;
        if (delta.costUsd > 0 || delta.tokensIn > 0 || delta.tokensOut > 0) amounts.push({ at: lastAt || fallbackAt, modelId: id, ...delta });
      }
      const after = totalCost();
      for (let i = firstOfStep; i < amounts.length; i++) spans.push({ before, after });
      continue;
    }
    if (line.startsWith('{"type":')) continue; // bookkeeping lines carry no time
    const at = timeOf(line);
    if (at !== null) lastAt = at;
  }
  return { state: { offset: prev.offset, lastAt, models }, amounts, spans };
}

/** Reads part of a file without blocking: opening a file can take a while on some systems. */
async function readBytes(file: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface Pending {
  id: string;
  file: string;
  size: number;
  mtimeMs: number;
}

export interface ScannerDeps {
  dir: () => string;
  usage: UsageStore;
  now: () => number;
  /** The story of the session in which a conversation is open here, if it is. */
  storyOf: (conversationId: string) => { storyId: string | null; storyName: string | null };
}

export class TranscriptScanner {
  private queue: Pending[] = [];

  constructor(private readonly deps: ScannerDeps) {}

  /** Finds the transcripts that have something unread, most recently written first. */
  private async refill(): Promise<void> {
    const oldest = this.deps.now() - MAX_AGE_MS;
    this.queue = (await listTranscriptFilesAsync(this.deps.dir()))
      .filter((t) => t.mtimeMs >= oldest)
      .filter((t) => t.size !== (this.deps.usage.fileState(t.file)?.offset ?? 0))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Reads up to about `budget` bytes of unread transcript. Returns whether more is waiting,
   * so that the caller can come back soon instead of at its idle pace.
   */
  async tick(budget: number): Promise<boolean> {
    if (this.queue.length === 0) await this.refill();
    let left = budget;
    while (left > 0 && this.queue.length > 0) {
      const t = this.queue[0]!;
      const used = await this.readSome(t, left);
      if (used === 0 || (this.deps.usage.fileState(t.file)?.offset ?? 0) >= t.size) this.queue.shift();
      if (used === 0) continue;
      left -= used;
    }
    return this.queue.length > 0;
  }

  /** Reads the next complete lines of one transcript. Returns the bytes consumed. */
  private async readSome(t: Pending, budget: number): Promise<number> {
    const { usage } = this.deps;
    let state = usage.fileState(t.file) ?? emptyFileState();
    // Shorter than what was already read: the file was replaced. Its totals start again.
    if (t.size < state.offset) state = emptyFileState();
    if (t.size <= state.offset) return 0;

    let want = Math.min(Math.max(budget, 64 * 1024), t.size - state.offset);
    let chunk: Buffer;
    let lastNewline: number;
    try {
      for (;;) {
        chunk = await readBytes(t.file, state.offset, want);
        lastNewline = chunk.lastIndexOf(0x0a);
        const more = state.offset + chunk.length < t.size;
        // One line longer than the step: read further until it ends, within reason.
        if (lastNewline >= 0 || !more || want >= MAX_READ_BYTES) break;
        want = Math.min(want * 4, MAX_READ_BYTES, t.size - state.offset);
      }
    } catch {
      return 0; // deleted or locked; it is looked at again at the next listing
    }
    // A last line with no end yet is still being written: leave it for next time.
    if (lastNewline < 0) return 0;

    const complete = chunk.subarray(0, lastNewline + 1);
    const scanned = scanText(complete.toString('utf8'), state, t.mtimeMs);
    usage.applyScan(t.file, { ...scanned.state, offset: state.offset + complete.length }, scanned.amounts, this.deps.storyOf(t.id), t.id, scanned.spans);
    return complete.length;
  }
}
