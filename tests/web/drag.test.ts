import { describe, expect, it } from 'vitest';
import type { SessionInfo, Story } from '../../src/shared/types.js';
import { areaOf, dropChangesNothing, endDragged, getDragged, reorderTo, restoreAfterFailure, startDragged, sessionDropOnArea, sessionDropOnSession, sortByIds, withSessionDrop } from '../../src/web/drag.js';

const session = (id: string, storyId: string | null): SessionInfo => ({ id, storyId }) as SessionInfo;
const story = (id: string): Story => ({ id, name: id }) as Story;

const stories = [story('s1'), story('s2')];
// a and b in s1, c in s2, d with no area, e in an area that was deleted.
const sessions = [session('a', 's1'), session('b', 's1'), session('c', 's2'), session('d', null), session('e', 'gone')];

describe('reorderTo', () => {
  it('gives the new order', () => expect(reorderTo(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']));
  it('is null when nothing changes', () => {
    expect(reorderTo(['a', 'b', 'c'], 'a', 'b', 'before')).toBeNull();
    expect(reorderTo(['a', 'b', 'c'], 'b', 'b', 'after')).toBeNull();
    expect(reorderTo(['a', 'b', 'c'], 'a', 'zz', 'after')).toBeNull();
  });
});

describe('sortByIds', () => {
  it('puts the items in the order of the ids, unlisted ones after', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(sortByIds(items, ['c', 'a']).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('areaOf', () => {
  it('is the story of the session, or null when it has none or it is gone', () => {
    expect(areaOf(sessions[0]!, stories)).toBe('s1');
    expect(areaOf(sessions[3]!, stories)).toBeNull();
    expect(areaOf(sessions[4]!, stories)).toBeNull();
  });
});

describe('sessionDropOnSession', () => {
  it('reorders inside the same area without moving', () => {
    expect(sessionDropOnSession(sessions, stories, 'b', 'a', 'before')).toEqual({ order: ['b', 'a', 'c', 'd', 'e'] });
  });
  it('moves to the area of the target and reorders', () => {
    expect(sessionDropOnSession(sessions, stories, 'a', 'c', 'after')).toEqual({ moveTo: 's2', order: ['b', 'c', 'a', 'd', 'e'] });
  });
  it('moves out of any area when the target has none', () => {
    expect(sessionDropOnSession(sessions, stories, 'a', 'd', 'before')).toEqual({ moveTo: null, order: ['b', 'c', 'a', 'd', 'e'] });
  });
  it('treats a deleted area like no area', () => {
    expect(sessionDropOnSession(sessions, stories, 'e', 'd', 'before')).toEqual({ order: ['a', 'b', 'c', 'e', 'd'] });
  });
  it('moves without reordering when the place is already right', () => {
    expect(sessionDropOnSession(sessions, stories, 'c', 'b', 'after')).toEqual({ moveTo: 's1' });
  });
  it('is null for a drop that changes nothing', () => {
    expect(sessionDropOnSession(sessions, stories, 'a', 'a', 'before')).toBeNull();
    expect(sessionDropOnSession(sessions, stories, 'a', 'b', 'before')).toBeNull();
    expect(sessionDropOnSession(sessions, stories, 'zz', 'a', 'before')).toBeNull();
    expect(sessionDropOnSession(sessions, stories, 'a', 'zz', 'before')).toBeNull();
  });
});

describe('sessionDropOnArea', () => {
  it('moves to another area', () => expect(sessionDropOnArea(sessions, stories, 'a', 's2')).toEqual({ moveTo: 's2' }));
  it('moves out of its area', () => expect(sessionDropOnArea(sessions, stories, 'a', null)).toEqual({ moveTo: null }));
  it('is null on its own area', () => {
    expect(sessionDropOnArea(sessions, stories, 'a', 's1')).toBeNull();
    expect(sessionDropOnArea(sessions, stories, 'e', null)).toBeNull();
    expect(sessionDropOnArea(sessions, stories, 'zz', 's1')).toBeNull();
  });
});

describe('withSessionDrop', () => {
  it('applies the move and the order to the list', () => {
    const next = withSessionDrop(sessions, 'a', { moveTo: 's2', order: ['b', 'c', 'a', 'd', 'e'] });
    expect(next.map((s) => [s.id, s.storyId])).toEqual([
      ['b', 's1'],
      ['c', 's2'],
      ['a', 's2'],
      ['d', null],
      ['e', 'gone'],
    ]);
  });
  it('leaves the list as it is without a move or an order', () => {
    expect(withSessionDrop(sessions, 'a', {})).toEqual(sessions);
  });
});

describe('dragged item', () => {
  it('is remembered from the start to the end of a drag', () => {
    expect(getDragged()).toBeNull();
    startDragged('t', 'a');
    expect(getDragged()).toEqual({ type: 't', id: 'a' });
    endDragged();
    expect(getDragged()).toBeNull();
  });
});

describe('dropChangesNothing', () => {
  const none = null;
  it('is false when nothing is dragged', () => expect(dropChangesNothing(none, 't', 'a')).toBe(false));
  it('is true over the dragged item itself', () => expect(dropChangesNothing({ type: 't', id: 'a' }, 't', 'a')).toBe(true));
  it('is false over another item, or another type', () => {
    expect(dropChangesNothing({ type: 't', id: 'a' }, 't', 'b')).toBe(false);
    expect(dropChangesNothing({ type: 'u', id: 'a' }, 't', 'a')).toBe(false);
  });
  it('is true for a session over its own area, through the area check', () => {
    const own = (id: string): boolean => sessionDropOnArea(sessions, stories, id, 's1') === null;
    expect(dropChangesNothing({ type: 't', id: 'a' }, 't', undefined, own)).toBe(true);
    expect(dropChangesNothing({ type: 't', id: 'c' }, 't', undefined, own)).toBe(false);
  });
});

describe('restoreAfterFailure', () => {
  it('restores the snapshot only while the store still holds the optimistic value', () => {
    const before = [1];
    const optimistic = [2];
    expect(restoreAfterFailure(optimistic, optimistic, before)).toBe(before);
    expect(restoreAfterFailure([3], optimistic, before)).toBeNull();
  });
});
