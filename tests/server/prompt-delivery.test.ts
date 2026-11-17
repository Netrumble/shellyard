import { describe, expect, it } from 'vitest';
import { PromptDelivery, pasteOf } from '../../src/server/prompt-delivery.js';

function setup() {
  let now = 1_000;
  const written: Array<[string, string]> = [];
  const outcomes: Array<[string, string | null]> = [];
  const alive = new Set(['s1']);
  const delivery = new PromptDelivery({ now: () => now, write: (id, data) => written.push([id, data]), alive: (id) => alive.has(id) });
  const expectPrompt = (prompt = 'Run the tests') => delivery.expect('s1', prompt, (outcome, detail) => outcomes.push([outcome, detail]));
  return { delivery, written, outcomes, alive, expectPrompt, advance: (ms: number) => { now += ms; delivery.tick(); } };
}

describe('PromptDelivery', () => {
  it('types nothing until Claude Code says it is ready', () => {
    const t = setup();
    t.expectPrompt();
    t.advance(5_000);
    expect(t.written).toEqual([]);
    expect(t.outcomes).toEqual([]);
  });

  it('pastes the prompt once ready, presses Enter a moment later, and waits to be told it was taken', () => {
    const t = setup();
    t.expectPrompt('Run the tests');
    t.delivery.ready('s1');
    t.advance(100);
    expect(t.written).toEqual([['s1', '\x1b[200~Run the tests\x1b[201~']]);
    t.advance(500);
    expect(t.written[1]).toEqual(['s1', '\r']);
    expect(t.outcomes).toEqual([]);
    t.delivery.submitted('s1');
    expect(t.outcomes).toEqual([['delivered', null]]);
    // Later reports from the same session mean nothing any more.
    t.delivery.ready('s1');
    t.advance(1_000);
    expect(t.written).toHaveLength(2);
  });

  it('types the prompt once, however many times readiness is reported', () => {
    const t = setup();
    t.expectPrompt();
    t.delivery.ready('s1');
    t.delivery.ready('s1');
    t.advance(100);
    t.delivery.ready('s1');
    t.advance(600);
    expect(t.written).toHaveLength(2);
  });

  it('gives up when Claude Code never becomes ready', () => {
    const t = setup();
    t.expectPrompt();
    t.advance(120_001);
    expect(t.written).toEqual([]);
    expect(t.outcomes).toEqual([['undelivered', 'Claude Code did not become ready within 2 minutes; the prompt was not typed.']]);
  });

  it('says so when the prompt was typed but never accepted', () => {
    const t = setup();
    t.expectPrompt();
    t.delivery.ready('s1');
    t.advance(100);
    t.advance(500);
    t.advance(30_001);
    expect(t.outcomes).toEqual([['undelivered', 'The prompt was typed, but Claude Code did not confirm it took it.']]);
  });

  it('stops waiting for a session that has gone', () => {
    const t = setup();
    t.expectPrompt();
    t.alive.delete('s1');
    t.advance(1_000);
    expect(t.outcomes).toEqual([['undelivered', 'The session ended before the prompt could be typed.']]);
    t.delivery.ready('s1');
    t.advance(1_000);
    expect(t.written).toEqual([]);
  });

  it('does not count a prompt the user typed themselves before ours was sent', () => {
    const t = setup();
    t.expectPrompt();
    t.delivery.submitted('s1');
    expect(t.outcomes).toEqual([]);
  });
});

describe('pasteOf', () => {
  it('keeps the lines of a prompt and removes what could end the paste or act as a key', () => {
    expect(pasteOf('one\r\ntwo\rthree\tx')).toBe('\x1b[200~one\ntwo\nthree\tx\x1b[201~');
    expect(pasteOf('a\x1b[201~b\x03c\x7f')).toBe('\x1b[200~a[201~bc\x1b[201~');
  });
});
