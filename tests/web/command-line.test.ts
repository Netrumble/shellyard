import { describe, expect, it } from 'vitest';
import { splitCommandLine } from '../../src/web/command-line.js';

describe('splitCommandLine', () => {
  it('splits a program from its arguments', () => {
    expect(splitCommandLine('  wsl -d  Ubuntu ')).toEqual(['wsl', '-d', 'Ubuntu']);
  });

  it('keeps a quoted path with spaces in one part', () => {
    expect(splitCommandLine('"C:\Program Files\Git\bin\bash.exe" --login')).toEqual(['C:\Program Files\Git\bin\bash.exe', '--login']);
  });

  it('keeps an empty quoted argument', () => {
    expect(splitCommandLine('cmd ""')).toEqual(['cmd', '']);
  });

  it('gives nothing for a blank line', () => {
    expect(splitCommandLine('   ')).toEqual([]);
  });
});
