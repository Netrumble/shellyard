import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

// On macOS an app opened from the Finder, the Dock or Launchpad does not get the PATH of the
// user's shell: launchd gives it /usr/bin:/bin:/usr/sbin:/sbin only. Node (from Homebrew, nvm,
// the installer), claude and code would not be found, by the app nor by the server it starts.
// So the PATH is asked of the user's login shell, as a terminal would set it up.

const MARK = '__SHELLYARD_PATH__';

/** Where Homebrew and the Node installer put their programs, in case the shell says nothing. */
export const MAC_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** The PATH between the two marks in what the shell printed; whatever its profile printed around it is ignored. */
export function parseMarkedPath(printed) {
  const m = new RegExp(`${MARK}\\r?\\n([^\\r\\n]*)\\r?\\n${MARK}`).exec(printed);
  const path = m?.[1]?.trim();
  return path ? path : null;
}

/** The folders of several PATH values, in order, each once; relative entries are dropped. */
export function mergePaths(...values) {
  const out = [];
  for (const v of values) {
    if (!v) continue;
    for (const dir of v.split(':')) if (dir && isAbsolute(dir) && !out.includes(dir)) out.push(dir);
  }
  return out.join(':');
}

/** The PATH the user's login shell sets up, or null if it could not be read in time. */
export function loginShellPath(env = process.env, run = execFileSync) {
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  try {
    // printenv rather than $PATH: fish, among others, does not print $PATH with colons.
    const printed = run(shell, ['-ilc', `echo ${MARK}; /usr/bin/printenv PATH; echo ${MARK}`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    return parseMarkedPath(String(printed));
  } catch {
    return null;
  }
}

/** On macOS, gives the process the PATH of the login shell, followed by what it had and the usual folders. */
export function adoptLoginPath(env = process.env, platform = process.platform, run = execFileSync) {
  if (platform !== 'darwin') return;
  env.PATH = mergePaths(loginShellPath(env, run), env.PATH, MAC_FALLBACK_DIRS.join(':'));
}
