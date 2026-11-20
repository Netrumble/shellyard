import { describe, expect, it } from 'vitest';
import { glyphLabel, glyphOf, spinSeconds, type Glyph } from '../../src/web/status-glyph.js';
import { session } from './session-fixture.js';

describe('glyphOf', () => {
  it('gives each state of a Claude session its own shape', () => {
    expect(glyphOf(session('a', 'attention', 'blocked'))).toBe('needs');
    expect(glyphOf(session('a', 'attention', 'maybe-waiting'))).toBe('maybe');
    expect(glyphOf(session('a', 'attention', 'finished'))).toBe('finished');
    expect(glyphOf(session('a', 'working'))).toBe('working');
    expect(glyphOf(session('a', 'idle'))).toBe('idle');
    expect(glyphOf(session('a', 'exited'))).toBe('exited');
  });

  it('shows a shell as working only while it prints', () => {
    const shell = session('s', 'running', null, 0, 'shell');
    expect(glyphOf(shell)).toBe('idle');
    expect(glyphOf(shell, 0)).toBe('idle');
    expect(glyphOf(shell, 120)).toBe('working');
  });

  it('keeps a Claude session working even when it prints nothing', () => {
    expect(glyphOf(session('a', 'working'), 0)).toBe('working');
  });

  it('shows an ended shell as exited', () => {
    expect(glyphOf(session('s', 'exited', null, 0, 'shell'), 500)).toBe('exited');
  });
});

describe('glyphLabel', () => {
  it('names every glyph, so the state reads without colour or shape', () => {
    const all: Glyph[] = ['needs', 'maybe', 'working', 'finished', 'idle', 'exited'];
    const labels = all.map(glyphLabel);
    expect(labels).toEqual(['Needs you', 'Possibly waiting', 'Working', 'Finished', 'Idle', 'Exited']);
  });
});

describe('spinSeconds', () => {
  it('stands still when nothing is printed', () => {
    expect(spinSeconds(0)).toBeNull();
    expect(spinSeconds(-3)).toBeNull();
    expect(spinSeconds(Number.NaN)).toBeNull();
  });

  it('turns faster the more is printed', () => {
    const slow = spinSeconds(10)!;
    const fast = spinSeconds(50_000)!;
    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBeGreaterThanOrEqual(0.6);
    expect(slow).toBeLessThanOrEqual(2.4);
  });
});
