import { describe, expect, it } from 'vitest';
import { applyOrder } from '../../src/server/order.js';

const id = (t: { id: string }) => t.id;
const items = ['a', 'b', 'c', 'd'].map((x) => ({ id: x }));

describe('applyOrder', () => {
  it('orders by ids', () => {
    expect(applyOrder(items, ['c', 'a', 'd', 'b'], id).map(id)).toEqual(['c', 'a', 'd', 'b']);
  });
  it('ignores unknown ids and keeps missing ones', () => {
    expect(applyOrder(items, ['d', 'zzz', 'b'], id).map(id)).toEqual(['d', 'b', 'a', 'c']);
  });
  it('ignores duplicates', () => {
    expect(applyOrder(items, ['c', 'c', 'a'], id).map(id)).toEqual(['c', 'a', 'b', 'd']);
  });
});
