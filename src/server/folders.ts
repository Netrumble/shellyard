import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

// A browser cannot open the system's folder dialog and learn the full path that was chosen,
// so the page browses folders through the server instead. Only folder names are exposed, and
// only to the page that already holds the token, which could list them from a shell anyway.

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderListing {
  path: string;
  /** Null at the top of a drive or of the file system. */
  parent: string | null;
  folders: FolderEntry[];
  /** Places to jump to: the drives on Windows, "/" elsewhere. */
  roots: string[];
}

export class FolderError extends Error {}

const MAX_ENTRIES = 2000;

function roots(platform: NodeJS.Platform, current: string): string[] {
  if (platform !== 'win32') return ['/'];
  const found: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (existsSync(drive)) found.push(drive);
  }
  const own = parse(current).root;
  if (own && !found.some((r) => r.toLowerCase() === own.toLowerCase())) found.push(own);
  return found;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The sub-folders of a folder; the home folder when none is given. */
export function listFolders(requested: string | undefined, platform: NodeJS.Platform = process.platform): FolderListing {
  const wanted = (requested ?? '').trim();
  if (wanted && !isAbsolute(wanted)) throw new FolderError('Give the full path of a folder.');
  const path = wanted ? resolve(wanted) : homedir();
  if (!existsSync(path)) throw new FolderError(`Folder does not exist: ${path}`);
  if (!isFolder(path)) throw new FolderError(`Not a folder: ${path}`);

  let names: string[];
  try {
    names = readdirSync(path, { withFileTypes: true })
      // A link to a folder counts as one; statSync follows it.
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isFolder(join(path, e.name))))
      .map((e) => e.name);
  } catch (e) {
    throw new FolderError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const parent = dirname(path);
  return {
    path,
    parent: parent === path ? null : parent,
    folders: names.slice(0, MAX_ENTRIES).map((name) => ({ name, path: join(path, name) })),
    roots: roots(platform, path),
  };
}
