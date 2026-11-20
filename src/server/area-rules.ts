import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AreaRule } from '../shared/types.js';
import { normalizePattern, patternError, ruleMatches } from '../shared/rules.js';

// The area rules, kept in a file of their own (rules.json): they change with every request they
// answer, which config.json, edited by people, should not. A file that cannot be read gives no
// rules, so that a damaged file can only make ShellYard ask more, never less.

const FILE_VERSION = 1;
const WEEK_MS = 7 * 24 * 3_600_000;
/** Answers remembered per rule, at most: enough to count a busy week. */
const MAX_HITS = 2000;

interface Stored {
  id: string;
  storyId: string;
  pattern: string;
  enabled: boolean;
  createdAt: number;
  /** When it answered a request, oldest first; only the last 7 days are kept. */
  hits: number[];
}

export class RuleError extends Error {}

function toStored(v: unknown): Stored | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.storyId !== 'string' || typeof o.pattern !== 'string') return null;
  const pattern = normalizePattern(o.pattern);
  if (!pattern) return null;
  const hits = Array.isArray(o.hits) ? o.hits.filter((h): h is number => typeof h === 'number' && Number.isFinite(h)) : [];
  return {
    id: o.id,
    storyId: o.storyId,
    pattern,
    // Only a rule switched on in so many words is on.
    enabled: o.enabled === true,
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0,
    hits: hits.slice(-MAX_HITS),
  };
}

export class RuleStore {
  private rules: Stored[];
  private readonly changeCbs: Array<(rules: AreaRule[]) => void> = [];

  constructor(private readonly deps: { file: string; now: () => number }) {
    this.rules = this.load();
  }

  private load(): Stored[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.deps.file, 'utf8'));
      const list = (raw as { rules?: unknown } | null)?.rules;
      if (!Array.isArray(list)) return [];
      return list.map(toStored).filter((r): r is Stored => r !== null);
    } catch {
      return [];
    }
  }

  /** Writes the file; `strict`: a failure is the caller's (a change the user made must not be lost silently). */
  private save(strict: boolean): void {
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, rules: this.rules }, null, 1));
      renameSync(tmp, this.deps.file);
    } catch (e) {
      if (strict) throw new RuleError(`The rules could not be saved: ${(e as Error).message}`);
    }
    const list = this.list();
    for (const cb of this.changeCbs) cb(list);
  }

  private toPublic(r: Stored): AreaRule {
    const since = this.deps.now() - WEEK_MS;
    return { id: r.id, storyId: r.storyId, pattern: r.pattern, enabled: r.enabled, createdAt: r.createdAt, weekHits: r.hits.filter((h) => h > since).length };
  }

  /** Oldest first. */
  list(): AreaRule[] {
    return this.rules.map((r) => this.toPublic(r));
  }

  /**
   * Adds a rule to an area, switched on. A pattern the area already has is switched on again
   * rather than added twice. Throws RuleError with the reason for a pattern that cannot be one.
   */
  create(storyId: string, pattern: string): AreaRule {
    const problem = patternError(pattern);
    if (problem) throw new RuleError(problem);
    const normal = normalizePattern(pattern)!;
    const existing = this.rules.find((r) => r.storyId === storyId && r.pattern === normal);
    if (existing) {
      const before = existing.enabled;
      existing.enabled = true;
      try {
        this.save(true);
      } catch (e) {
        existing.enabled = before;
        throw e;
      }
      return this.toPublic(existing);
    }
    const rule: Stored = { id: `rule-${randomUUID().slice(0, 8)}`, storyId, pattern: normal, enabled: true, createdAt: this.deps.now(), hits: [] };
    this.rules = [...this.rules, rule];
    try {
      this.save(true);
    } catch (e) {
      this.rules = this.rules.filter((r) => r !== rule);
      throw e;
    }
    return this.toPublic(rule);
  }

  /** Switches a rule on or off, or changes its pattern. Null for an unknown rule. */
  update(id: string, patch: { enabled?: boolean; pattern?: string }): AreaRule | null {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return null;
    const before = { ...rule };
    if (patch.pattern !== undefined) {
      const problem = patternError(patch.pattern);
      if (problem) throw new RuleError(problem);
      rule.pattern = normalizePattern(patch.pattern)!;
    }
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    try {
      this.save(true);
    } catch (e) {
      Object.assign(rule, before);
      throw e;
    }
    return this.toPublic(rule);
  }

  remove(id: string): boolean {
    const before = this.rules;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before.length) return false;
    try {
      this.save(true);
    } catch (e) {
      this.rules = before;
      throw e;
    }
    return true;
  }

  /** An area that is deleted takes its rules with it. */
  removeStory(storyId: string): void {
    if (!this.rules.some((r) => r.storyId === storyId)) return;
    this.rules = this.rules.filter((r) => r.storyId !== storyId);
    this.save(false);
  }

  /**
   * The rule of the area that allows this request, if one does, counting the answer. Only Bash
   * commands are ever allowed by a rule.
   */
  decide(storyId: string | null, tool: string | null, command: string | null): AreaRule | null {
    if (!storyId || tool !== 'Bash' || !command) return null;
    const rule = this.rules.find((r) => r.enabled && r.storyId === storyId && ruleMatches(r.pattern, command));
    if (!rule) return null;
    const now = this.deps.now();
    rule.hits = [...rule.hits.filter((h) => h > now - WEEK_MS), now].slice(-MAX_HITS);
    this.save(false);
    return this.toPublic(rule);
  }

  onChange(cb: (rules: AreaRule[]) => void): void {
    this.changeCbs.push(cb);
  }
}
