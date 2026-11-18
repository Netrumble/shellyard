import { describe, expect, it } from 'vitest';
import { elapsedLabel, newlyWaiting, reasonLabel, titleFor, visibleCards } from '../../src/web/attention.js';
import { session } from './store.test.js';

const a = session('a', 'attention', 'blocked', 1);
const b = session('b', 'attention', 'finished', 2);
const c = session('c', 'attention', 'finished', 3);

describe('visibleCards', () => {
  it('shows the waiting sessions in their order', () => {
    expect(visibleCards([a, b, c], [], null)).toEqual(['a', 'b', 'c']);
  });
  it('keeps the focused card in place after it leaves attention', () => {
    expect(visibleCards([a, c], ['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c']);
  });
  it('keeps the focused card at the front or at the end too', () => {
    expect(visibleCards([b, c], ['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
    expect(visibleCards([a, b], ['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c']);
  });
  it('drops a card that left attention once it is not focused', () => {
    expect(visibleCards([a, c], ['a', 'b', 'c'], null)).toEqual(['a', 'c']);
  });
  it('does not resurrect a focused id that was never a card', () => {
    expect(visibleCards([a], ['a'], 'z')).toEqual(['a']);
  });
  it('does not move the card being typed in when the order around it changes', () => {
    // b is focused and sits second; a new blocked session d would sort before it.
    const d = session('d', 'attention', 'blocked', 9);
    expect(visibleCards([a, d, b, c], ['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'd', 'c']);
  });
  it('does not duplicate a focused card that is still waiting', () => {
    expect(visibleCards([a, b, c], ['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c']);
  });
});

describe('titleFor', () => {
  it('shows the count only when something waits', () => {
    expect(titleFor(0)).toBe('ShellYard');
    expect(titleFor(2)).toBe('(2) ShellYard');
  });
});

describe('newlyWaiting', () => {
  it('reports only fresh entries into attention', () => {
    const prev = [session('a', 'working'), session('b', 'attention', 'blocked')];
    const next = [session('a', 'attention', 'finished'), session('b', 'attention', 'blocked'), session('c', 'attention', 'blocked')];
    expect(newlyWaiting(prev, next).map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('a change of reason within attention is not a new entry', () => {
    expect(newlyWaiting([session('a', 'attention', 'maybe-waiting')], [session('a', 'attention', 'blocked')])).toEqual([]);
  });
  it('reports nothing when nothing changed or sessions left', () => {
    expect(newlyWaiting([a, b], [a])).toEqual([]);
    expect(newlyWaiting([], [])).toEqual([]);
  });
});

describe('labels', () => {
  it('explains why a session waits', () => {
    expect(reasonLabel(session('x', 'attention', 'blocked'))).toBe('Permission or input needed');
    expect(reasonLabel(session('x', 'attention', 'maybe-waiting'))).toBe('Possibly waiting');
    expect(reasonLabel(session('x', 'attention', 'finished'))).toBe('Finished, awaiting prompt');
    expect(reasonLabel(session('x', 'working'))).toBe('Working');
  });
  it('formats elapsed time compactly', () => {
    expect(elapsedLabel(0)).toBe('0 s');
    expect(elapsedLabel(40_000)).toBe('40 s');
    expect(elapsedLabel(60_000)).toBe('1 min');
    expect(elapsedLabel(4 * 60_000 + 59_000)).toBe('4 min');
    expect(elapsedLabel(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 5 min');
    expect(elapsedLabel(-500)).toBe('0 s');
  });
});
