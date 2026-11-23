/**
 * Search in a terminal's text, screen and scrollback.
 *
 * Plain Ctrl+F belongs to the program in the terminal (a shell moves the cursor forward with
 * it), so the search opens with Ctrl+Shift+F, as in Windows Terminal, or Cmd+F on a Mac,
 * where Cmd is never sent to the terminal.
 */
export function isSearchKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  if (e.altKey || e.key.toLowerCase() !== 'f') return false;
  if (e.shiftKey && (e.ctrlKey || e.metaKey)) return true;
  return e.metaKey && !e.ctrlKey;
}

/** How many matches the search highlights at most; past that it only says "more than". */
export const HIGHLIGHT_LIMIT = 1000;

/**
 * What the search bar says about the matches. The addon gives the index -1 when the match on
 * screen cannot be numbered: past the highlight limit, or before a first match was picked.
 */
export function searchCountText(query: string, result: { resultIndex: number; resultCount: number } | null, invalid: boolean): string {
  if (!query) return '';
  if (invalid) return 'Invalid pattern';
  if (!result || result.resultCount === 0) return 'No results';
  if (result.resultCount >= HIGHLIGHT_LIMIT && result.resultIndex < 0) return `More than ${HIGHLIGHT_LIMIT}`;
  if (result.resultIndex < 0) return `${result.resultCount} found`;
  return `${result.resultIndex + 1} of ${result.resultCount}`;
}

/** Whether a regular expression can be compiled; a pattern being typed often cannot yet. */
export function isValidPattern(query: string, regex: boolean): boolean {
  if (!regex) return true;
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}
