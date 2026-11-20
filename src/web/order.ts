export type Place = 'before' | 'after';

/**
 * The list with `dragged` moved next to `target`. A dragged id that is not in the list is
 * added; a target that is not in the list, or the dragged item itself, changes nothing.
 */
export function moveInOrder(ids: string[], dragged: string, target: string, place: Place): string[] {
  if (dragged === target || !ids.includes(target)) return ids;
  const rest = ids.filter((id) => id !== dragged);
  const at = rest.indexOf(target) + (place === 'after' ? 1 : 0);
  return [...rest.slice(0, at), dragged, ...rest.slice(at)];
}

/** Where a drop lands on a row: the top half puts it before, the bottom half after. */
export function placeFor(offsetY: number, height: number): Place {
  return offsetY < height / 2 ? 'before' : 'after';
}
