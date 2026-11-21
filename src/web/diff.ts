import type { ChangeStatus, ChangeSummary } from '../shared/types.js';

/** A line of a diff as shown: a hunk heading, a line added, removed or unchanged, or a note. */
export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note';
  text: string;
  /** Its number in the committed file; null where it has none there. */
  oldNo: number | null;
  /** Its number in the file as it is now; null where it has none there. */
  newNo: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * Reads a unified diff (git's, of one file) into rows with line numbers. The headers before the
 * first hunk (diff --git, index, ---, +++) are left out: the dialog names the file itself.
 */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const h = HUNK.exec(line);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      rows.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff ')) {
      inHunk = false;
      continue;
    }
    const mark = line[0];
    const body = line.slice(1);
    if (mark === '+') rows.push({ kind: 'add', text: body, oldNo: null, newNo: newNo++ });
    else if (mark === '-') rows.push({ kind: 'del', text: body, oldNo: oldNo++, newNo: null });
    else if (mark === '\\') rows.push({ kind: 'note', text: body.trim(), oldNo: null, newNo: null });
    else rows.push({ kind: 'ctx', text: mark === ' ' ? body : line, oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}

/** "3 files · +42 −7", for the badge of a session. */
export function changeText(c: Pick<ChangeSummary, 'files' | 'added' | 'removed'>): string {
  return `${c.files} ${c.files === 1 ? 'file' : 'files'} · +${c.added} −${c.removed}`;
}

/** The same in words, for screen readers and tooltips. */
export function changeLabel(c: Pick<ChangeSummary, 'files' | 'added' | 'removed'>): string {
  const files = `${c.files} ${c.files === 1 ? 'file' : 'files'} changed`;
  return `${files}, ${c.added} ${c.added === 1 ? 'line' : 'lines'} added, ${c.removed} removed, not committed`;
}

/** One letter per status, as git and editors show them. */
export const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  typechange: 'T',
  conflicted: '!',
};

export const STATUS_WORD: Record<ChangeStatus, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'new, not tracked',
  typechange: 'type changed',
  conflicted: 'conflict',
};

/** The folder and the name of a file path, to show the name first. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
