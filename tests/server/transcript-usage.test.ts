import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyFileState, scanText, TranscriptScanner } from '../../src/server/transcript-usage.js';
import { UsageStore } from '../../src/server/usage.js';
import { useTempHome } from '../helpers.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

const msg = (iso: string): string => JSON.stringify({ parentUuid: null, type: 'assistant', message: { role: 'assistant', content: [] }, timestamp: iso, sessionId: ID_A });
/** A cost-state line as Claude Code writes it after a turn: running totals per model. */
const cost = (models: Record<string, [cost: number, input: number, output: number, cacheRead?: number, cacheWrite?: number]>): string =>
  JSON.stringify({
    type: 'cost-state',
    sessionId: ID_A,
    totalCostUSD: Object.values(models).reduce((s, m) => s + m[0], 0),
    modelUsage: Object.fromEntries(
      Object.entries(models).map(([id, m]) => [id, { costUSD: m[0], inputTokens: m[1], outputTokens: m[2], cacheReadInputTokens: m[3] ?? 0, cacheCreationInputTokens: m[4] ?? 0 }]),
    ),
  });
const text = (...lines: string[]): string => lines.join('\n') + '\n';
const T1 = '2026-11-17T10:00:00.000Z';
const T2 = '2026-11-17T11:00:00.000Z';

describe('scanText', () => {
  it('turns the running totals in a transcript into amounts, dated by the message before them', () => {
    const r = scanText(text(msg(T1), cost({ opus: [1, 100, 10] }), msg(T2), cost({ opus: [1.5, 150, 25] })), emptyFileState(), 0);
    expect(r.amounts).toEqual([
      { at: Date.parse(T1), modelId: 'opus', costUsd: 1, tokensIn: 100, tokensOut: 10 },
      { at: Date.parse(T2), modelId: 'opus', costUsd: 0.5, tokensIn: 50, tokensOut: 15 },
    ]);
    expect(r.state.models.opus).toEqual({ costUsd: 1.5, tokensIn: 150, tokensOut: 25 });
    expect(r.state.lastAt).toBe(Date.parse(T2));
  });

  it('counts cache reads and writes as input tokens', () => {
    const r = scanText(text(msg(T1), cost({ opus: [1, 2, 4, 30000, 20000] })), emptyFileState(), 0);
    expect(r.amounts[0]).toMatchObject({ tokensIn: 50002, tokensOut: 4 });
  });

  it('keeps models apart', () => {
    const r = scanText(text(msg(T1), cost({ opus: [1, 10, 1], haiku: [0.2, 5, 1] }), cost({ opus: [1, 10, 1], haiku: [0.5, 9, 2] })), emptyFileState(), 0);
    expect(r.amounts.map((a) => [a.modelId, a.costUsd])).toEqual([['opus', 1], ['haiku', 0.2], ['haiku', 0.3]].map(([m, c]) => [m, expect.closeTo(c as number, 6)]));
  });

  it('adds nothing for a repeated total', () => {
    const r = scanText(text(msg(T1), cost({ opus: [1, 10, 1] }), cost({ opus: [1, 10, 1] }), cost({ opus: [1, 10, 1] })), emptyFileState(), 0);
    expect(r.amounts).toHaveLength(1);
  });

  it('continues from where an earlier read stopped, without counting twice', () => {
    const first = scanText(text(msg(T1), cost({ opus: [1, 100, 10] })), emptyFileState(), 0);
    const second = scanText(text(msg(T2), cost({ opus: [1.25, 120, 12] })), first.state, 0);
    expect(second.amounts).toEqual([{ at: Date.parse(T2), modelId: 'opus', costUsd: 0.25, tokensIn: 20, tokensOut: 2 }]);
  });

  it('takes a total that went down as a count restarted from zero', () => {
    const r = scanText(text(msg(T1), cost({ opus: [5, 500, 50] }), msg(T2), cost({ opus: [0.4, 40, 4] })), emptyFileState(), 0);
    expect(r.amounts.map((a) => a.costUsd)).toEqual([5, 0.4]);
  });

  it('dates amounts by the fallback time when no message came before them', () => {
    const r = scanText(text(cost({ opus: [1, 1, 1] })), emptyFileState(), 12345);
    expect(r.amounts[0]!.at).toBe(12345);
  });

  it('skips damaged lines, absurd figures and anything it does not know', () => {
    const r = scanText(
      text(
        msg(T1),
        '{"type":"cost-state", broken',
        JSON.stringify({ type: 'cost-state', modelUsage: 'nope' }),
        JSON.stringify({ type: 'cost-state', modelUsage: { opus: { costUSD: 'a lot', inputTokens: -1 } } }),
        JSON.stringify({ type: 'cost-state', modelUsage: { opus: { costUSD: 1e9, inputTokens: 1, outputTokens: 1 } } }),
        JSON.stringify({ type: 'api-request-blob', blob: '\\"timestamp\\":\\"1999-01-01T00:00:00.000Z\\" "type":"cost-state"' }),
        cost({ opus: [2, 20, 2] }),
      ),
      emptyFileState(),
      0,
    );
    expect(r.amounts).toEqual([{ at: Date.parse(T1), modelId: 'opus', costUsd: 2, tokensIn: 20, tokensOut: 2 }]);
  });

  it('is not slowed to a crawl by very long lines', () => {
    const blob = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(400_000) });
    const big = text(msg(T1), ...Array.from({ length: 20 }, () => blob), cost({ opus: [1, 1, 1] }));
    const started = Date.now();
    expect(scanText(big, emptyFileState(), 0).amounts).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('TranscriptScanner', () => {
  const home = useTempHome();
  let projects = '';
  let now = 0;
  let store: UsageStore;
  let scanner: TranscriptScanner;
  let stories: Record<string, { storyId: string; storyName: string }>;

  const file = (project: string, id: string): string => join(projects, project, `${id}.jsonl`);
  function write(project: string, id: string, content: string, ageMs = 0): string {
    mkdirSync(join(projects, project), { recursive: true });
    const f = file(project, id);
    writeFileSync(f, content);
    const when = new Date(now - ageMs);
    utimesSync(f, when, when);
    return f;
  }
  /** Scans until nothing is left to read. */
  const drain = async (budget = 1 << 20): Promise<void> => {
    for (let i = 0; i < 1000 && (await scanner.tick(budget)); i++);
  };

  beforeEach(() => {
    now = Date.parse('2026-11-17T12:00:00.000Z');
    projects = join(home.dir(), 'projects');
    mkdirSync(projects);
    stories = {};
    store = new UsageStore({ now: () => now, file: join(home.dir(), 'usage.json') });
    scanner = new TranscriptScanner({ dir: () => projects, usage: store, now: () => now, storyOf: (id) => stories[id] ?? { storyId: null, storyName: null } });
  });

  it('counts what every conversation on the machine cost, whoever started it', async () => {
    write('p1', ID_A, text(msg(T1), cost({ opus: [3, 300, 30] })));
    write('p2', ID_B, text(msg(T2), cost({ haiku: [1, 100, 10] })));
    await drain();
    const { today } = store.summary();
    expect(today.costUsd).toBeCloseTo(4);
    expect(today.byModel.map((l) => [l.key, l.costUsd])).toEqual([['opus', 3], ['haiku', 1]]);
  });

  it('adds only what is new when a transcript grows', async () => {
    const f = write('p', ID_A, text(msg(T1), cost({ opus: [3, 300, 30] })));
    await drain();
    await drain();
    expect(store.summary().today.costUsd).toBeCloseTo(3);
    appendFileSync(f, text(msg(T2), cost({ opus: [3.5, 340, 36] })));
    await drain();
    const { today } = store.summary();
    expect(today.costUsd).toBeCloseTo(3.5);
    expect(today.byModel[0]).toMatchObject({ tokensIn: 340, tokensOut: 36 });
  });

  it('waits for a line that is still being written', async () => {
    const half = cost({ opus: [2, 20, 2] });
    const f = write('p', ID_A, text(msg(T1)) + half.slice(0, 40));
    await drain();
    expect(store.summary().today.costUsd).toBe(0);
    appendFileSync(f, half.slice(40) + '\n');
    await drain();
    expect(store.summary().today.costUsd).toBeCloseTo(2);
  });

  it('reads a large transcript in several steps and ends with the same total', async () => {
    const blob = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(50_000) });
    const parts: string[] = [];
    for (let i = 1; i <= 20; i++) parts.push(msg(T1), blob, cost({ opus: [i * 0.1, i * 10, i] }));
    write('p', ID_A, text(...parts));
    let steps = 0;
    while ((await scanner.tick(100_000)) && steps < 500) steps++;
    expect(steps).toBeGreaterThan(3);
    expect(store.summary().today.costUsd).toBeCloseTo(2);
  });

  it('gets through a single line longer than its step', async () => {
    const blob = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(300_000) });
    write('p', ID_A, text(msg(T1), blob, cost({ opus: [1, 1, 1] })));
    await drain(50_000);
    expect(store.summary().today.costUsd).toBeCloseTo(1);
  });

  it('puts each amount on the day it was spent', async () => {
    write('p', ID_A, text(msg('2026-11-15T10:00:00.000Z'), cost({ opus: [5, 1, 1] }), msg('2026-11-17T10:00:00.000Z'), cost({ opus: [6, 2, 2] })));
    await drain();
    const s = store.summary();
    expect(s.today.costUsd).toBeCloseTo(1);
    expect(s.week.costUsd).toBeCloseTo(6);
  });

  it('files a conversation open in a story under that story, the rest under none', async () => {
    stories[ID_A] = { storyId: 's1', storyName: 'Payroll' };
    write('p', ID_A, text(msg(T1), cost({ opus: [3, 1, 1] })));
    write('p', ID_B, text(msg(T1), cost({ opus: [1, 1, 1] })));
    await drain();
    expect(store.summary().today.byStory.map((l) => [l.label, l.costUsd])).toEqual([['Payroll', 3], ['No area', 1]]);
  });

  it('does not count again after a restart of the server', async () => {
    write('p', ID_A, text(msg(T1), cost({ opus: [3, 300, 30] })));
    await drain();
    store.flush();
    const store2 = new UsageStore({ now: () => now, file: join(home.dir(), 'usage.json') });
    const scanner2 = new TranscriptScanner({ dir: () => projects, usage: store2, now: () => now, storyOf: () => ({ storyId: null, storyName: null }) });
    for (let i = 0; i < 100 && (await scanner2.tick(1 << 20)); i++);
    expect(store2.summary().today.costUsd).toBeCloseTo(3);
  });

  it('starts over on a transcript that was replaced by a shorter one', async () => {
    const f = write('p', ID_A, text(msg(T1), cost({ opus: [3, 300, 30] }), msg(T1), msg(T1)));
    await drain();
    writeFileSync(f, text(msg(T2), cost({ opus: [0.5, 5, 1] })));
    await drain();
    expect(store.summary().today.costUsd).toBeCloseTo(3.5);
  });

  it('leaves transcripts untouched for over a month alone', async () => {
    write('p', ID_A, text(msg('2026-09-01T10:00:00.000Z'), cost({ opus: [50, 1, 1] })), 40 * 86_400_000);
    await drain();
    expect(store.summary().month.costUsd).toBe(0);
  });

  it('does its reading without holding the process up', async () => {
    for (let i = 0; i < 30; i++) write('p' + i, `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, text(msg(T1), cost({ opus: [1, 1, 1] })));
    // A timer that should fire while the scan is in progress: it can only if the scan yields.
    let fired = 0;
    const timer = setInterval(() => fired++, 1);
    const pending = scanner.tick(1 << 30);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    clearInterval(timer);
    expect(store.summary().today.costUsd).toBeCloseTo(30);
    expect(fired).toBeGreaterThan(0);
  });

  it('reports no work left when there is nothing new', async () => {
    write('p', ID_A, text(msg(T1), cost({ opus: [1, 1, 1] })));
    await drain();
    expect(await scanner.tick(1 << 20)).toBe(false);
  });

  it('does nothing, without failing, when Claude Code has never run here', async () => {
    const lonely = new TranscriptScanner({ dir: () => join(home.dir(), 'nowhere'), usage: store, now: () => now, storyOf: () => ({ storyId: null, storyName: null }) });
    expect(await lonely.tick(1 << 20)).toBe(false);
  });

  describe('a session counted live from its status reports, and later found in its transcript', () => {
    const live = (costUsd: number, tokensIn = 0, tokensOut = 0) => ({ modelId: 'opus', modelName: 'Opus', costUsd, tokensIn, tokensOut, fiveHour: null, sevenDay: null });
    const here = { storyId: null, storyName: null, conversationId: ID_A };

    it('is not counted a second time when the transcript catches up', async () => {
      store.record('session', live(1, 100, 10), here);
      store.record('session', live(3, 300, 30), here);
      expect(store.summary().today.costUsd).toBeCloseTo(3);
      // The session ends; Claude Code writes its totals into the transcript.
      write('p', ID_A, text(msg(T1), cost({ opus: [3, 300, 30] })));
      await drain();
      const { today } = store.summary();
      expect(today.costUsd).toBeCloseTo(3);
      expect(today.byModel[0]).toMatchObject({ tokensIn: 300, tokensOut: 30 });
    });

    it('gains only what the status reports had not yet shown', async () => {
      store.record('session', live(3), here);
      write('p', ID_A, text(msg(T1), cost({ opus: [3.4, 1, 1] })));
      await drain();
      expect(store.summary().today.costUsd).toBeCloseTo(3.4);
    });

    it('does not hold back the cost of other conversations', async () => {
      store.record('session', live(3), here);
      write('p', ID_B, text(msg(T1), cost({ opus: [2, 1, 1] })));
      await drain();
      expect(store.summary().today.costUsd).toBeCloseTo(5);
    });

    it('keeps this straight across a restart of the server', async () => {
      store.record('session', live(3), here);
      store.flush();
      const store2 = new UsageStore({ now: () => now, file: join(home.dir(), 'usage.json') });
      const scanner2 = new TranscriptScanner({ dir: () => projects, usage: store2, now: () => now, storyOf: () => ({ storyId: null, storyName: null }) });
      write('p', ID_A, text(msg(T1), cost({ opus: [3, 1, 1] })));
      for (let i = 0; i < 100 && (await scanner2.tick(1 << 20)); i++);
      expect(store2.summary().today.costUsd).toBeCloseTo(3);
    });

    it('a resumed conversation: its past comes from the transcript, its present from the reports', async () => {
      // Yesterday's run, already in the transcript.
      write('p', ID_A, text(msg('2026-11-16T10:00:00.000Z'), cost({ opus: [7, 700, 70] })));
      await drain();
      // Resumed here: Claude Code restores the 7 and reports from there.
      const resumed = { ...here, resumed: true };
      store.record('session', live(7, 700, 70), resumed);
      store.record('session', live(7.25, 720, 75), resumed);
      const s = store.summary();
      expect(s.today.costUsd).toBeCloseTo(0.25);
      expect(s.week.costUsd).toBeCloseTo(7.25);
      // It ends; the transcript now says 7.25 in all.
      appendFileSync(file('p', ID_A), text(msg(T2), cost({ opus: [7.25, 720, 75] })));
      await drain();
      expect(store.summary().week.costUsd).toBeCloseTo(7.25);
      expect(store.summary().today.costUsd).toBeCloseTo(0.25);
    });
  });

  it('shows the name Claude Code gives a model once it is known', async () => {
    write('p', ID_A, text(msg(T1), cost({ 'claude-opus-x': [1, 1, 1] })));
    await drain();
    expect(store.summary().today.byModel[0]!.label).toBe('claude-opus-x');
    store.learnModelName('claude-opus-x', 'Opus X');
    expect(store.summary().today.byModel[0]!.label).toBe('Opus X');
  });
});
