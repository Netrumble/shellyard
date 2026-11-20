import { describe, expect, it } from 'vitest';
import { nextSelection, queueAction, SETTLE_MS, step, type QueueContext } from '../../src/web/answer-queue.js';

const press = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean }> = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods });
const ctx = (over: Partial<QueueContext> = {}): QueueContext => ({ typing: false, onButton: false, answerable: true, canAlways: false, sinceAdvanceMs: 10_000, hasItem: true, ...over });

describe('queueAction', () => {
  it('maps the letters of the queue to their actions, either case', () => {
    expect(queueAction(press('a'), ctx())).toBe('allow');
    expect(queueAction(press('A'), ctx())).toBe('allow');
    expect(queueAction(press('d'), ctx())).toBe('deny');
    expect(queueAction(press('r'), ctx())).toBe('reply');
    expect(queueAction(press('j'), ctx())).toBe('next');
    expect(queueAction(press('k'), ctx())).toBe('prev');
    expect(queueAction(press('ArrowDown'), ctx())).toBe('next');
    expect(queueAction(press('ArrowUp'), ctx())).toBe('prev');
    expect(queueAction(press('Enter'), ctx())).toBe('open');
  });

  it('offers "always in this area" only where it exists', () => {
    expect(queueAction(press('s'), ctx())).toBeNull();
    expect(queueAction(press('s'), ctx({ canAlways: true }))).toBe('always');
  });

  it('answers only a permission that can be answered', () => {
    expect(queueAction(press('a'), ctx({ answerable: false }))).toBeNull();
    expect(queueAction(press('d'), ctx({ answerable: false }))).toBeNull();
    expect(queueAction(press('s'), ctx({ answerable: false, canAlways: true }))).toBeNull();
    expect(queueAction(press('r'), ctx({ answerable: false }))).toBe('reply');
  });

  it('does nothing with an empty queue but move', () => {
    expect(queueAction(press('a'), ctx({ hasItem: false }))).toBeNull();
    expect(queueAction(press('Enter'), ctx({ hasItem: false }))).toBeNull();
    expect(queueAction(press('r'), ctx({ hasItem: false }))).toBeNull();
  });

  it('lets Enter press the button that has the focus, keeping the letters working', () => {
    expect(queueAction(press('Enter'), ctx({ onButton: true }))).toBeNull();
    expect(queueAction(press('a'), ctx({ onButton: true }))).toBe('allow');
    expect(queueAction(press('j'), ctx({ onButton: true }))).toBe('next');
  });

  it('leaves the keys to a terminal or a field being typed in', () => {
    for (const k of ['a', 'd', 'r', 'j', 'Enter']) expect(queueAction(press(k), ctx({ typing: true }))).toBeNull();
  });

  it('ignores keys with Ctrl, Alt or Meta, and a held answer key', () => {
    expect(queueAction(press('a', { ctrlKey: true }), ctx())).toBeNull();
    expect(queueAction(press('d', { altKey: true }), ctx())).toBeNull();
    expect(queueAction(press('j', { metaKey: true }), ctx())).toBeNull();
    expect(queueAction(press('a', { repeat: true }), ctx())).toBeNull();
    expect(queueAction(press('j', { repeat: true }), ctx())).toBe('next');
  });

  it('does not answer a request that has just come on screen', () => {
    expect(queueAction(press('a'), ctx({ sinceAdvanceMs: SETTLE_MS - 1 }))).toBeNull();
    expect(queueAction(press('d'), ctx({ sinceAdvanceMs: 0 }))).toBeNull();
    expect(queueAction(press('j'), ctx({ sinceAdvanceMs: 0 }))).toBe('next');
    expect(queueAction(press('a'), ctx({ sinceAdvanceMs: SETTLE_MS }))).toBe('allow');
  });
});

describe('nextSelection', () => {
  it('keeps the selection while it is in the queue', () => {
    expect(nextSelection(['a', 'b'], ['b', 'a', 'c'], 'a')).toBe('a');
  });

  it('moves to the item that took the place of one that left', () => {
    expect(nextSelection(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c');
  });

  it('moves to the new last item when the last one left', () => {
    expect(nextSelection(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b');
  });

  it('picks the first item when nothing was selected, and nothing in an empty queue', () => {
    expect(nextSelection([], ['x', 'y'], null)).toBe('x');
    expect(nextSelection(['a'], [], 'a')).toBeNull();
  });
});

describe('step', () => {
  it('moves one item and stops at the ends', () => {
    expect(step(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(step(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(step(['a', 'b', 'c'], 'a', -1)).toBe('a');
    expect(step(['a', 'b', 'c'], null, 1)).toBe('a');
    expect(step([], null, 1)).toBeNull();
  });
});
