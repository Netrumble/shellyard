// The version of the next release: the major and minor of the base version (VERSION_BASE in the
// workflow), and as patch one more than the highest patch already released with that major and
// minor. With no release of that major and minor yet, the patch is 0.
//
//   gh release list --json tagName -q '.[].tagName' | node next-version.mjs 0.2.0
//
// reads the tags of the releases on stdin, one per line ("v0.2.0" or "0.2.0"), and prints the
// version without "v". Tags of another major or minor, and pre-releases ("v0.2.3-beta"), are
// ignored.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function nextVersion(base, tags) {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(String(base).trim());
  if (!m) throw new Error(`The base version must be major.minor.patch, such as 0.2.0, not "${base}".`);
  const [, major, minor] = m;
  let highest = -1;
  for (const tag of tags) {
    const t = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
    if (!t || Number(t[1]) !== Number(major) || Number(t[2]) !== Number(minor)) continue;
    highest = Math.max(highest, Number(t[3]));
  }
  return `${Number(major)}.${Number(minor)}.${highest + 1}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tags = readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
  process.stdout.write(`${nextVersion(process.argv[2] ?? '', tags)}\n`);
}
