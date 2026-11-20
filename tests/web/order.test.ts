import { describe, expect, it } from 'vitest';
import { moveInOrder, placeFor } from '../../src/web/order.js';

describe('moveInOrder', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('moves before a target', () => expect(moveInOrder(ids, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']));
  it('moves after a target', () => expect(moveInOrder(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']));
  it('leaves the order when dropped on itself', () => expect(moveInOrder(ids, 'b', 'b', 'before')).toEqual(ids));
  it('adds a dragged item that is not in the list at the target', () => expect(moveInOrder(ids, 'x', 'c', 'after')).toEqual(['a', 'b', 'c', 'x', 'd']));
  it('leaves the order when the target is missing', () => expect(moveInOrder(ids, 'a', 'zz', 'before')).toEqual(ids));
});

describe('placeFor', () => {
  it('is before in the top half and after in the bottom half', () => {
    expect(placeFor(10, 100)).toBe('before');
    expect(placeFor(60, 100)).toBe('after');
  });
});
