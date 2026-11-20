import { describe, expect, it } from 'vitest';
import { eventOf, pickSound, shouldPlay } from '../../src/web/sounds.js';
import type { SoundSettings, Story } from '../../src/shared/types.js';
import { session } from './store.test.js';

const settings: SoundSettings = { blocked: 'sb', finished: 'sf', maybeWaiting: null };
const story = (id: string, sound: string): Story => ({ id, name: id, ticket: '', cwd: '', color: '', sound });
const blocked = session('b', 'attention', 'blocked');
const finished = session('f', 'attention', 'finished');
const maybe = session('m', 'attention', 'maybe-waiting');

describe('eventOf', () => {
  it('maps reasons to events, null to maybeWaiting', () => {
    expect(eventOf(blocked)).toBe('blocked');
    expect(eventOf(finished)).toBe('finished');
    expect(eventOf(maybe)).toBe('maybeWaiting');
    expect(eventOf(session('x', 'attention', null))).toBe('maybeWaiting');
  });
});

describe('pickSound', () => {
  it('is undefined when nothing waits', () => expect(pickSound([], [], settings)).toBeUndefined());
  it('picks the most urgent event: blocked, finished, maybeWaiting', () => {
    expect(pickSound([maybe, finished, blocked], [], settings)).toBe('sb');
    expect(pickSound([maybe, finished], [], settings)).toBe('sf');
    expect(pickSound([maybe], [], settings)).toBeNull();
  });
  it('area sound overrides the event sound', () => {
    const s = { ...blocked, storyId: 'a' };
    expect(pickSound([s], [story('a', 'mine')], settings)).toBe('mine');
  });
  it('uses the event sound when the area has none', () => {
    const s = { ...blocked, storyId: 'a' };
    expect(pickSound([s], [story('a', '')], settings)).toBe('sb');
  });
  it('plays one sound for several waiting sessions', () => {
    const one = { ...blocked, id: 'b1', storyId: 'a' };
    const two = { ...blocked, id: 'b2', storyId: 'c' };
    expect(pickSound([one, two], [story('a', 'first'), story('c', 'second')], settings)).toBe('first');
  });
});

describe('shouldPlay', () => {
  it('stays silent when the page has focus or sound is off', () => {
    expect(shouldPlay(true, true)).toBe(false);
    expect(shouldPlay(false, false)).toBe(false);
    expect(shouldPlay(false, true)).toBe(true);
  });
});
