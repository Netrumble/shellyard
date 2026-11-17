import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FolderError, listFolders } from '../../src/server/folders.js';
import { useTempHome } from '../helpers.js';

describe('listFolders', () => {
  const home = useTempHome();

  it('lists the sub-folders of a folder, sorted without regard to case, and not its files', () => {
    for (const name of ['beta', 'Alpha', 'gamma']) mkdirSync(join(home.dir(), name));
    writeFileSync(join(home.dir(), 'file.txt'), '');
    const l = listFolders(home.dir());
    expect(l.path).toBe(home.dir());
    expect(l.folders).toEqual([
      { name: 'Alpha', path: join(home.dir(), 'Alpha') },
      { name: 'beta', path: join(home.dir(), 'beta') },
      { name: 'gamma', path: join(home.dir(), 'gamma') },
    ]);
  });

  it('gives the parent, and none at the top of a drive or of the file system', () => {
    expect(listFolders(home.dir()).parent).toBe(dirname(home.dir()));
    const root = parse(home.dir()).root;
    expect(listFolders(root).parent).toBeNull();
  });

  it('starts from the home folder when no path is given', () => {
    expect(listFolders(undefined).path).toBe(homedir());
    expect(listFolders('  ').path).toBe(homedir());
  });

  it('lists names with spaces and non-ASCII characters', () => {
    mkdirSync(join(home.dir(), 'café – été'));
    expect(listFolders(home.dir()).folders.map((f) => f.name)).toContain('café – été');
  });

  it('names the places to start from', () => {
    const { roots } = listFolders(home.dir());
    expect(roots.length).toBeGreaterThan(0);
    expect(roots).toContain(parse(home.dir()).root);
  });

  it('refuses a folder that does not exist, a file, and a relative path', () => {
    expect(() => listFolders(join(home.dir(), 'nope'))).toThrow(FolderError);
    writeFileSync(join(home.dir(), 'file.txt'), '');
    expect(() => listFolders(join(home.dir(), 'file.txt'))).toThrow(/not a folder/i);
    expect(() => listFolders('relative/path')).toThrow(/full path/i);
  });

  it('is empty, not an error, for a folder with nothing in it', () => {
    mkdirSync(join(home.dir(), 'empty'));
    expect(listFolders(join(home.dir(), 'empty')).folders).toEqual([]);
  });
});
