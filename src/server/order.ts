/**
 * Puts items in the order given by ids. Unknown ids and repeats are ignored; items the list
 * does not mention keep their relative order after the listed ones.
 */
export function applyOrder<T>(items: T[], ids: string[], idOf: (t: T) => string): T[] {
  const byId = new Map<string, T>();
  for (const item of items) if (!byId.has(idOf(item))) byId.set(idOf(item), item);
  const out: T[] = [];
  const placed = new Set<T>();
  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined || placed.has(item)) continue;
    placed.add(item);
    out.push(item);
  }
  for (const item of items) if (!placed.has(item)) out.push(item);
  return out;
}
