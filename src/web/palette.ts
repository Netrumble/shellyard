// The command palette (Ctrl K): what can be jumped to or done, ranked against what is typed.

export interface Rankable {
  id: string;
  title: string;
  /** More words it is found by, not shown. */
  keywords?: string;
}

/** How well one word of the query matches some text; null when it does not. */
function scoreTerm(text: string, term: string): number | null {
  const at = text.indexOf(term);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s\-_/.:·"'(]/.test(text[at - 1]!);
    return 100 + (wordStart ? 50 : 0) - Math.min(at, 40);
  }
  // The letters in order, with gaps: weaker the more they are spread.
  let pos = -1;
  let gaps = 0;
  for (const ch of term) {
    const next = text.indexOf(ch, pos + 1);
    if (next < 0) return null;
    if (pos >= 0) gaps += next - pos - 1;
    pos = next;
  }
  return Math.max(1, 50 - gaps);
}

/** How well a query matches some text: every word must; 0 for an empty query; null for no match. */
export function scoreMatch(text: string, query: string): number | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  let total = 0;
  for (const t of terms) {
    const s = scoreTerm(hay, t);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** The items that match, the best first (ties keep their order), at most `limit`. */
export function rankItems<T extends Rankable>(items: T[], query: string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => {
      const title = scoreMatch(item.title, query);
      const keys = item.keywords ? scoreMatch(`${item.title} ${item.keywords}`, query) : null;
      // A match in the title counts more than one found only through the keywords.
      const score = title !== null ? title + 1000 : keys;
      return { item, i, score };
    })
    .filter((x): x is { item: T; i: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

/**
 * Whether a key opens the palette. Ctrl K (Cmd K) anywhere but in a terminal, where it cuts the
 * rest of the line; Ctrl Shift K from anywhere, terminals included.
 */
export function paletteKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, inTerminal: boolean): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey || !(e.ctrlKey || e.metaKey)) return false;
  return e.shiftKey || !inTerminal;
}
