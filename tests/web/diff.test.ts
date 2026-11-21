import { describe, expect, it } from 'vitest';
import { changeLabel, changeText, parseDiff, splitPath } from '../../src/web/diff.js';

describe('parseDiff', () => {
  it('numbers the lines of each hunk and leaves the headers out', () => {
    const text = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,4 @@ heading',
      ' one',
      '-two',
      '+2',
      ' three',
      '+four',
      '@@ -10,1 +11,1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(parseDiff(text)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,4 @@ heading', oldNo: null, newNo: null },
      { kind: 'ctx', text: 'one', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'two', oldNo: 2, newNo: null },
      { kind: 'add', text: '2', oldNo: null, newNo: 2 },
      { kind: 'ctx', text: 'three', oldNo: 3, newNo: 3 },
      { kind: 'add', text: 'four', oldNo: null, newNo: 4 },
      { kind: 'hunk', text: '@@ -10,1 +11,1 @@', oldNo: null, newNo: null },
      { kind: 'del', text: 'old', oldNo: 10, newNo: null },
      { kind: 'add', text: 'new', oldNo: null, newNo: 11 },
      { kind: 'note', text: 'No newline at end of file', oldNo: null, newNo: null },
    ]);
  });

  it('reads a hunk heading without counts, and a new file', () => {
    expect(parseDiff('--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+only\n')).toEqual([
      { kind: 'hunk', text: '@@ -0,0 +1 @@', oldNo: null, newNo: null },
      { kind: 'add', text: 'only', oldNo: null, newNo: 1 },
    ]);
  });

  it('keeps lines that look like headers inside a hunk', () => {
    const rows = parseDiff('@@ -1,2 +1,2 @@\n---- a rule\n++++ more\n');
    expect(rows.slice(1)).toEqual([
      { kind: 'del', text: '--- a rule', oldNo: 1, newNo: null },
      { kind: 'add', text: '+++ more', oldNo: null, newNo: 1 },
    ]);
  });

  it('gives nothing for an empty or binary diff', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toEqual([]);
  });
});

describe('changeText and changeLabel', () => {
  it('says files and lines', () => {
    expect(changeText({ files: 3, added: 42, removed: 7 })).toBe('3 files · +42 −7');
    expect(changeText({ files: 1, added: 1, removed: 0 })).toBe('1 file · +1 −0');
    expect(changeLabel({ files: 1, added: 1, removed: 2 })).toBe('1 file changed, 1 line added, 2 removed, not committed');
  });
});

describe('splitPath', () => {
  it('splits folder and name', () => {
    expect(splitPath('src/web/a.ts')).toEqual({ dir: 'src/web/', name: 'a.ts' });
    expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' });
  });
});
