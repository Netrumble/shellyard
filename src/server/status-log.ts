import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { FlowDay, FlowSegment, FlowState, FlowSummary, SessionInfo } from '../shared/types.js';

// What the Claude sessions did, as the user lived it: how long they waited on the user, how
// long the user took to answer, how many worked at once. The last hour is kept per session for
// the timeline; each day is kept as a few totals (flow.json, two weeks), never as content.

const HOUR_MS = 3_600_000;
const DAYS_KEPT = 15;
const MAX_ANSWERS = 500;
const FILE_VERSION = 1;

interface DayTotals {
  day: string;
  blockedMs: number;
  answers: number[];
  /** Sum over time of the number of sessions working, while at least one was. */
  parallelMs: number;
  activeMs: number;
}

interface Track {
  name: string;
  state: FlowState | null;
  since: number;
  segments: FlowSegment[];
  gone: boolean;
}

/** The state a Claude session shows on the timeline; null for one that has ended. */
export function flowState(s: SessionInfo): FlowState | null {
  if (s.status === 'exited') return null;
  if (s.status === 'attention') return s.reason === 'finished' ? 'finished' : s.reason === 'maybe-waiting' ? 'maybe' : 'needs';
  if (s.status === 'working') return 'working';
  return 'idle';
}

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

export class StatusLog {
  private readonly tracks = new Map<string, Track>();
  private days: DayTotals[];
  /** The working count since the last change, and when it last changed. */
  private working = 0;
  private workingSince: number;

  constructor(private readonly deps: { now: () => number; file?: string }) {
    this.days = this.load();
    this.workingSince = deps.now();
  }

  private load(): DayTotals[] {
    if (!this.deps.file) return [];
    try {
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as { days?: unknown };
      if (!Array.isArray(raw.days)) return [];
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
      return raw.days
        .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null && typeof (d as { day?: unknown }).day === 'string')
        .map((d) => ({
          day: d.day as string,
          blockedMs: num(d.blockedMs),
          answers: Array.isArray(d.answers) ? d.answers.map(num).slice(-MAX_ANSWERS) : [],
          parallelMs: num(d.parallelMs),
          activeMs: num(d.activeMs),
        }))
        .slice(-DAYS_KEPT);
    } catch {
      return [];
    }
  }

  /** Writes the day totals; a failure only loses history. */
  persist(): void {
    if (!this.deps.file) return;
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, days: this.days }));
      renameSync(tmp, this.deps.file);
    } catch {
      // The flow is a convenience; the sessions matter more.
    }
  }

  private dayTotals(ms: number): DayTotals {
    const day = dayOf(ms);
    let d = this.days.find((x) => x.day === day);
    if (!d) {
      d = { day, blockedMs: 0, answers: [], parallelMs: 0, activeMs: 0 };
      this.days = [...this.days, d].slice(-DAYS_KEPT);
    }
    return d;
  }

  /** Adds the time since the last change to the parallel totals. */
  private settleWorking(now: number): void {
    const dt = now - this.workingSince;
    if (dt > 0 && this.working > 0) {
      const d = this.dayTotals(now);
      d.parallelMs += dt * this.working;
      d.activeMs += dt;
    }
    this.workingSince = now;
  }

  /** Takes the session list after a change; Claude sessions only. */
  observe(sessions: SessionInfo[]): void {
    const now = this.deps.now();
    this.settleWorking(now);
    const seen = new Set<string>();
    let working = 0;
    for (const s of sessions) {
      if (s.kind !== 'claude') continue;
      seen.add(s.id);
      const state = flowState(s);
      if (state === 'working') working++;
      let t = this.tracks.get(s.id);
      if (!t) {
        t = { name: s.name, state: null, since: now, segments: [], gone: false };
        this.tracks.set(s.id, t);
      }
      t.name = s.name;
      if (state !== t.state) this.move(t, state, now);
    }
    for (const [id, t] of this.tracks) {
      if (!seen.has(id) && !t.gone) {
        this.move(t, null, now);
        t.gone = true;
      }
    }
    this.working = working;
    this.prune(now);
  }

  private move(t: Track, next: FlowState | null, now: number): void {
    const open = t.segments.at(-1);
    if (open && open.to === null) open.to = now;
    if (t.state === 'needs') {
      const d = this.dayTotals(now);
      d.blockedMs += now - t.since;
      // Answered: the session went back to work. Closed or ended sessions are not answers.
      if (next === 'working') d.answers = [...d.answers, now - t.since].slice(-MAX_ANSWERS);
    }
    t.state = next;
    t.since = now;
    if (next) t.segments.push({ state: next, from: now, to: null });
  }

  private prune(now: number): void {
    const cutoff = now - HOUR_MS;
    for (const [id, t] of this.tracks) {
      t.segments = t.segments.filter((s) => s.to === null || s.to > cutoff);
      if (t.gone && t.segments.length === 0) this.tracks.delete(id);
    }
  }

  summary(): FlowSummary {
    const now = this.deps.now();
    this.settleWorking(now);
    this.prune(now);
    const today = this.dayTotals(now);
    // A block still going on counts up to now.
    let ongoing = 0;
    for (const t of this.tracks.values()) if (t.state === 'needs') ongoing += now - t.since;
    const day: FlowDay = {
      blockedMs: today.blockedMs + ongoing,
      medianAnswerMs: median(today.answers),
      answers: today.answers.length,
      parallel: today.activeMs > 0 ? Math.round((today.parallelMs / today.activeMs) * 10) / 10 : null,
    };
    const before = this.days.filter((d) => d.day < today.day).slice(-7).filter((d) => d.blockedMs > 0 || d.answers.length > 0 || d.activeMs > 0);
    const previous =
      before.length === 0
        ? null
        : {
            blockedMs: Math.round(before.reduce((n, d) => n + d.blockedMs, 0) / before.length),
            medianAnswerMs: median(before.flatMap((d) => d.answers)),
          };
    const from = now - HOUR_MS;
    const sessions = [...this.tracks.entries()]
      .filter(([, t]) => t.segments.length > 0)
      .map(([id, t]) => ({ id, name: t.name, segments: t.segments.map((s) => ({ ...s, from: Math.max(s.from, from) })) }));
    return { today: day, previous, timeline: { from, to: now, sessions } };
  }
}
