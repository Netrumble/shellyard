import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { LimitReading, UsageLine, UsagePeriod, UsageSummary } from '../shared/types.js';

// Usage is what Claude Code itself reports. Each session ShellYard starts has a status-line command
// that forwards Claude Code's status payload here. That payload carries the plan limits, and
// running totals for the session: its estimated cost, its tokens, the model in use. Running
// totals are turned into amounts per day, attributed to the model and the story of the moment.
//
// The payload arrives from hosted sessions, which are trusted only as far as the hook token
// goes: every value is bounded, and names are never used as keys of ordinary objects.

export interface StatusPayload {
  modelId: string | null;
  modelName: string | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  fiveHour: LimitReading | null;
  sevenDay: LimitReading | null;
}

/** Version 2: costs come from Claude Code's transcripts (version 1 counted status reports). */
const FILE_VERSION = 2;
const KEEP_DAYS = 90;
const SAVE_DELAY_MS = 5000;
const NO_STORY_LABEL = 'No area';
const MAX_NAME = 100;
const MAX_AMOUNT = 1e12;
/** More than this between two reports of one session is not usage, it is a broken counter. */
const MAX_COST_STEP = 1000;
const MAX_TOKEN_STEP = 1e9;

interface Amounts {
  label: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

type Dict<T> = Record<string, T>;
/** A dictionary with no prototype, so a key such as "__proto__" is just a key. */
const dict = <T>(): Dict<T> => Object.create(null) as Dict<T>;

interface Day {
  models: Dict<Amounts>;
  stories: Dict<Amounts>;
}

export interface ModelTotals {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** How far a transcript has been read, and the running totals it had reached. */
export interface FileState {
  offset: number;
  /** Time of the last message line read, to date what follows. */
  lastAt: number;
  models: Record<string, ModelTotals>;
}

/** The move of a conversation's running cost made by the step an amount belongs to. */
export interface CostSpan {
  before: number;
  after: number;
}

/** Something spent, as found in a transcript. */
export interface ScannedAmount {
  at: number;
  modelId: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

interface Baseline {
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, MAX_NAME) : null);

function reading(v: unknown): LimitReading | null {
  if (!isRecord(v)) return null;
  const pct = typeof v.used_percentage === 'number' && Number.isFinite(v.used_percentage) && v.used_percentage >= 0 ? Math.min(100, v.used_percentage) : null;
  // A time, not an amount: bounded separately (well past any real date, in either unit).
  const resets = typeof v.resets_at === 'number' && Number.isFinite(v.resets_at) && v.resets_at >= 0 && v.resets_at <= 1e14 ? v.resets_at : null;
  if (pct === null || resets === null) return null;
  // Claude Code sends seconds; anything already this large is milliseconds.
  return { usedPercentage: pct, resetsAt: resets < 1e12 ? resets * 1000 : resets };
}

/** A reading as this file saved it: already in milliseconds, so no unit guessing. */
function storedReading(v: unknown): LimitReading | null {
  if (!isRecord(v)) return null;
  const pct = amount(v.usedPercentage);
  const resets = typeof v.resetsAt === 'number' && Number.isFinite(v.resetsAt) && v.resetsAt >= 0 ? v.resetsAt : null;
  return pct === null || resets === null ? null : { usedPercentage: Math.min(100, pct), resetsAt: resets };
}

/** Picks out, and checks, the parts of Claude Code's status payload that are used here. */
export function parseStatusPayload(body: unknown): StatusPayload | null {
  if (!isRecord(body)) return null;
  const model = isRecord(body.model) ? body.model : {};
  const cost = isRecord(body.cost) ? body.cost : {};
  const context = isRecord(body.context_window) ? body.context_window : {};
  const limits = isRecord(body.rate_limits) ? body.rate_limits : {};
  return {
    modelId: text(model.id),
    modelName: text(model.display_name),
    costUsd: amount(cost.total_cost_usd),
    tokensIn: amount(context.total_input_tokens),
    tokensOut: amount(context.total_output_tokens),
    fiveHour: reading(limits.five_hour),
    sevenDay: reading(limits.seven_day),
  };
}

function readFiles(v: unknown): Dict<FileState> {
  const out = dict<FileState>();
  if (!isRecord(v)) return out;
  for (const [file, s] of Object.entries(v)) {
    if (!isRecord(s)) continue;
    const offset = amount(s.offset);
    if (offset === null) continue;
    const models = dict<ModelTotals>();
    if (isRecord(s.models)) {
      for (const [id, m] of Object.entries(s.models)) {
        if (!isRecord(m)) continue;
        models[id] = { costUsd: amount(m.costUsd) ?? 0, tokensIn: amount(m.tokensIn) ?? 0, tokensOut: amount(m.tokensOut) ?? 0 };
      }
    }
    out[file] = { offset, lastAt: typeof s.lastAt === 'number' && Number.isFinite(s.lastAt) ? s.lastAt : 0, models };
  }
  return out;
}

function readNames(v: unknown): Dict<string> {
  const out = dict<string>();
  if (!isRecord(v)) return out;
  for (const [id, name] of Object.entries(v)) if (typeof name === 'string' && name) out[id] = name.slice(0, MAX_NAME);
  return out;
}

function dayKeyOf(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The local calendar day `back` days before the one containing `ms`. Stepping by calendar
 * day, not by 24 hours: days are 23 or 25 hours long when the clocks change.
 */
function dayKey(ms: number, back = 0): string {
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return dayKeyOf(d);
}

function readAmounts(v: unknown): Dict<Amounts> {
  const out = dict<Amounts>();
  if (!isRecord(v)) return out;
  for (const [key, a] of Object.entries(v)) {
    if (!isRecord(a)) continue;
    out[key] = { label: text(a.label) ?? key, tokensIn: amount(a.tokensIn) ?? 0, tokensOut: amount(a.tokensOut) ?? 0, costUsd: amount(a.costUsd) ?? 0 };
  }
  return out;
}

function sameReading(a: LimitReading | null, b: LimitReading | null): boolean {
  return a === b || (a !== null && b !== null && a.usedPercentage === b.usedPercentage && a.resetsAt === b.resetsAt);
}

export class UsageStore {
  private days = dict<Day>();
  /** How far each transcript has been read. Saved with the amounts, so neither gets ahead. */
  private files = dict<FileState>();
  /** Display names of models, learnt from Claude Code's status reports. */
  private names = dict<string>();
  /**
   * Per conversation, the stretch of its running cost that was counted from live status
   * reports. Claude Code writes a conversation's totals into its transcript only now and
   * then (when the session ends, mostly), so sessions running here are counted from their
   * status reports as they go. Both sources speak of the same running total, so when the
   * transcript later covers a stretch already counted live, that stretch is left out.
   */
  private live = dict<{ from: number; to: number }>();
  private limits: UsageSummary['limits'] = { fiveHour: null, sevenDay: null, readAt: null };
  /** Last running totals seen per session. Sessions do not outlive the server, so neither do these. */
  private readonly baselines = new Map<string, Baseline>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly changeCbs: Array<() => void> = [];

  constructor(private readonly deps: { now: () => number; file: string }) {
    this.load();
  }

  private load(): void {
    const { file } = this.deps;
    if (!existsSync(file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      this.setAside('.bad');
      return;
    }
    if (!isRecord(raw)) {
      this.setAside('.bad');
      return;
    }
    // A file from a later version may hold things this one would drop on the next save.
    if (typeof raw.version === 'number' && raw.version > FILE_VERSION) {
      this.setAside('.newer');
      return;
    }
    // An older file counted costs another way; mixing the two would count things twice.
    if (raw.version !== FILE_VERSION) {
      this.setAside('.old');
      return;
    }
    this.files = readFiles(raw.files);
    this.names = readNames(raw.names);
    if (isRecord(raw.live)) {
      for (const [id, r] of Object.entries(raw.live)) {
        if (!isRecord(r)) continue;
        const from = amount(r.from);
        const to = amount(r.to);
        if (from !== null && to !== null && to >= from) this.live[id] = { from, to };
      }
    }
    if (isRecord(raw.days)) {
      for (const [key, d] of Object.entries(raw.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !isRecord(d)) continue;
        this.days[key] = { models: readAmounts(d.models), stories: readAmounts(d.stories) };
      }
    }
    if (isRecord(raw.limits)) {
      this.limits = { fiveHour: storedReading(raw.limits.fiveHour), sevenDay: storedReading(raw.limits.sevenDay), readAt: amount(raw.limits.readAt) };
    }
  }

  private setAside(suffix: string): void {
    try {
      rmSync(this.deps.file + suffix, { force: true });
      renameSync(this.deps.file, this.deps.file + suffix);
    } catch {
      // Counting from now matters more than keeping the old file.
    }
  }

  /**
   * Whether an incoming limit reading should replace the stored one. A session that has been
   * idle re-sends what it last knew, which may belong to a window that has since ended, or
   * to an earlier window than the one another session already reported.
   */
  private accept(incoming: LimitReading | null, stored: LimitReading | null, now: number): boolean {
    if (!incoming || incoming.resetsAt <= now) return false;
    if (!stored || stored.resetsAt <= now) return true;
    return incoming.resetsAt >= stored.resetsAt;
  }

  /** Takes one status payload of a session, with the story the session is in right now. */
  record(
    sessionId: string,
    p: StatusPayload,
    ctx: { storyId: string | null; storyName: string | null; resumed?: boolean; conversationId?: string | null },
  ): void {
    const now = this.deps.now();
    let changed = false;

    // On resume Claude Code restores the running totals of the conversation's earlier runs.
    // Those were counted (or predate ShellYard): the first report only sets where to count from.
    const first = !this.baselines.has(sessionId);
    const base =
      first && ctx.resumed
        ? { costUsd: p.costUsd ?? 0, tokensIn: p.tokensIn ?? 0, tokensOut: p.tokensOut ?? 0 }
        : (this.baselines.get(sessionId) ?? { costUsd: 0, tokensIn: 0, tokensOut: 0 });
    // A running total lower than the last one seen means the count restarted (a compacted or
    // resumed session), and an enormous jump means the counter is broken: either way take it
    // as the new baseline and add nothing. Never a negative amount, never an absurd one.
    const step = (current: number | null, previous: number, max: number): { delta: number; next: number } => {
      if (current === null) return { delta: 0, next: previous };
      const delta = current - previous;
      return { delta: delta > 0 && delta <= max ? delta : 0, next: current };
    };
    const cost = step(p.costUsd, base.costUsd, MAX_COST_STEP);
    const tin = step(p.tokensIn, base.tokensIn, MAX_TOKEN_STEP);
    const tout = step(p.tokensOut, base.tokensOut, MAX_TOKEN_STEP);
    this.baselines.set(sessionId, { costUsd: cost.next, tokensIn: tin.next, tokensOut: tout.next });

    if (cost.delta > 0 || tin.delta > 0 || tout.delta > 0) {
      const key = dayKey(now);
      const day = (this.days[key] ??= { models: dict<Amounts>(), stories: dict<Amounts>() });
      const add = (bucket: Dict<Amounts>, k: string, label: string): void => {
        const a = (bucket[k] ??= { label, tokensIn: 0, tokensOut: 0, costUsd: 0 });
        a.label = label;
        a.tokensIn += tin.delta;
        a.tokensOut += tout.delta;
        a.costUsd += cost.delta;
      };
      add(day.models, p.modelId ?? 'unknown', p.modelName ?? p.modelId ?? 'Unknown model');
      const storyId = ctx.storyId ? ctx.storyId.slice(0, MAX_NAME) : '';
      add(day.stories, storyId, storyId ? (ctx.storyName ?? storyId).slice(0, MAX_NAME) : NO_STORY_LABEL);
      if (ctx.conversationId && cost.delta > 0) {
        // The stretch of the running total just counted: from where this report started.
        const range = this.live[ctx.conversationId];
        if (range) {
          range.from = Math.min(range.from, base.costUsd);
          range.to = Math.max(range.to, cost.next);
        } else {
          this.live[ctx.conversationId] = { from: base.costUsd, to: cost.next };
        }
      }
      changed = true;
    }

    const five = this.accept(p.fiveHour, this.limits.fiveHour, now) ? p.fiveHour : this.limits.fiveHour;
    const seven = this.accept(p.sevenDay, this.limits.sevenDay, now) ? p.sevenDay : this.limits.sevenDay;
    const accepted = (five === p.fiveHour && p.fiveHour !== null) || (seven === p.sevenDay && p.sevenDay !== null);
    if (accepted) {
      if (!sameReading(five, this.limits.fiveHour) || !sameReading(seven, this.limits.sevenDay)) changed = true;
      this.limits = { fiveHour: five, sevenDay: seven, readAt: now };
    }

    if (changed) {
      this.dirty = true;
      this.scheduleSave();
      for (const cb of this.changeCbs) cb();
    }
  }

  /** How far a transcript has been read; null if never. */
  fileState(file: string): FileState | null {
    return this.files[file] ?? null;
  }

  /**
   * Takes what a read of a transcript found: the amounts, and the point reached. Both are
   * recorded together, so that a restart neither loses an amount nor counts it twice.
   */
  applyScan(
    file: string,
    state: FileState,
    amounts: ScannedAmount[],
    story: { storyId: string | null; storyName: string | null },
    conversationId: string | null = null,
    spans: CostSpan[] = [],
  ): void {
    this.files[file] = state;
    this.dirty = true;
    // The part of each step that the live reports of this conversation already counted is
    // left out: the step moved the running total from span.before to span.after, and the
    // reports covered range.from to range.to.
    const range = conversationId ? this.live[conversationId] : undefined;
    if (range) {
      amounts = amounts
        .map((a, i) => {
          const span = spans[i];
          if (!span || span.after <= span.before) return a;
          const overlap = Math.max(0, Math.min(span.after, range.to) - Math.max(span.before, range.from));
          const keep = Math.max(0, 1 - overlap / (span.after - span.before));
          return { ...a, costUsd: a.costUsd * keep, tokensIn: Math.round(a.tokensIn * keep), tokensOut: Math.round(a.tokensOut * keep) };
        })
        .filter((a) => a.costUsd > 1e-9 || a.tokensIn > 0 || a.tokensOut > 0);
      // Once the transcript has passed the stretch counted live, there is nothing left to guard.
      if (spans.some((s) => s.after >= range.to)) delete this.live[conversationId!];
    }
    const storyId = story.storyId ? story.storyId.slice(0, MAX_NAME) : '';
    const storyLabel = storyId ? (story.storyName ?? storyId).slice(0, MAX_NAME) : NO_STORY_LABEL;
    for (const a of amounts) {
      const day = (this.days[dayKey(a.at)] ??= { models: dict<Amounts>(), stories: dict<Amounts>() });
      for (const [bucket, key, label] of [
        [day.models, a.modelId, a.modelId],
        [day.stories, storyId, storyLabel],
      ] as const) {
        const t = (bucket[key] ??= { label, tokensIn: 0, tokensOut: 0, costUsd: 0 });
        t.label = label;
        t.tokensIn += a.tokensIn;
        t.tokensOut += a.tokensOut;
        t.costUsd += a.costUsd;
      }
    }
    this.scheduleSave();
    if (amounts.length > 0) for (const cb of this.changeCbs) cb();
  }

  /** Remembers what Claude Code calls a model, to show that in place of its id. */
  learnModelName(id: string | null, name: string | null): void {
    if (!id || !name || this.names[id] === name) return;
    this.names[id] = name;
    this.dirty = true;
    this.scheduleSave();
    for (const cb of this.changeCbs) cb();
  }

  /** Forgets the running totals of a session that is gone. */
  forgetSession(sessionId: string): void {
    this.baselines.delete(sessionId);
  }

  /** Today plus the previous `days - 1` calendar days. */
  private period(days: number): UsagePeriod {
    const now = this.deps.now();
    const models = dict<Amounts>();
    const stories = dict<Amounts>();
    const merge = (into: Dict<Amounts>, from: Dict<Amounts>): void => {
      for (const [key, a] of Object.entries(from)) {
        // Days are visited newest first, so the first label seen is the current name.
        const t = (into[key] ??= { label: a.label, tokensIn: 0, tokensOut: 0, costUsd: 0 });
        t.tokensIn += a.tokensIn;
        t.tokensOut += a.tokensOut;
        t.costUsd += a.costUsd;
      }
    };
    for (let i = 0; i < days; i++) {
      const day = this.days[dayKey(now, i)];
      if (!day) continue;
      merge(models, day.models);
      merge(stories, day.stories);
    }
    const lines = (bucket: Dict<Amounts>): UsageLine[] =>
      Object.entries(bucket)
        .map(([key, a]) => ({ key, label: a.label, tokensIn: a.tokensIn, tokensOut: a.tokensOut, costUsd: a.costUsd }))
        .sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label));
    const byModel = lines(models).map((l) => ({ ...l, label: this.names[l.key] ?? l.label }));
    return { costUsd: byModel.reduce((sum, l) => sum + l.costUsd, 0), byModel, byStory: lines(stories) };
  }

  summary(): UsageSummary {
    return {
      limits: { ...this.limits },
      today: this.period(1),
      week: this.period(7),
      month: this.period(30),
    };
  }

  /** The local day the store considers "today"; it changing means the summary changed too. */
  today(): string {
    return dayKey(this.deps.now());
  }

  onChange(cb: () => void): void {
    this.changeCbs.push(cb);
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Writes the file now, if anything changed since the last write. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    const oldest = dayKey(this.deps.now(), KEEP_DAYS);
    for (const key of Object.keys(this.days)) if (key < oldest) delete this.days[key];
    try {
      const tmp = `${this.deps.file}.tmp`;
      // Transcripts no longer on disk need no reading position kept.
      for (const file of Object.keys(this.files)) if (!existsSync(file)) delete this.files[file];
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, days: this.days, limits: this.limits, files: this.files, names: this.names, live: this.live }, null, 1));
      renameSync(tmp, this.deps.file);
      this.dirty = false;
    } catch {
      // Usage history is a convenience; failing to save it must not disturb the sessions.
      // It stays marked as unsaved and is tried again at the next change.
    }
  }
}
