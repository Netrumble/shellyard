import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The Node program on PATH, or null. The server must run on real Node, not on the Electron
 * binary: it hands its own executable path to Claude Code's hooks and status line.
 */
export function findNode(env = process.env, platform = process.platform) {
  const pathVar = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = ((pathVar && env[pathVar]) || '').split(delimiter).filter(Boolean);
  const names = platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of dirs) for (const n of names) if (isFile(join(dir, n))) return join(dir, n);
  return null;
}
