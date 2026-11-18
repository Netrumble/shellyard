import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveExecutable } from './shells.js';

// Opens VS Code on the folder of a session. For a session that runs in WSL the folder is
// opened inside its distribution (VS Code's WSL remote), not as a Windows folder.
//
// The folder is the one the session was started in. Where its shell has moved to since is
// not known to ShellYard.

export type EditorTarget = { kind: 'local'; path: string } | { kind: 'wsl'; distro: string; path: string } | { kind: 'error'; message: string };

export interface WslInfo {
  distro: string;
  home: string;
}

/** What WSL says about a distribution (null: the default one); null when it cannot be asked. */
export type AskWsl = (distro: string | null) => WslInfo | null;

/** The distribution and start folder a `wsl` command line names, or null if it is not WSL. */
export function wslOf(command: string, args: string[]): { distro: string | null; cd: string | null } | null {
  const name = basename(command.replace(/\\/g, '/')).toLowerCase();
  if (name !== 'wsl' && name !== 'wsl.exe') return null;
  let distro: string | null = null;
  let cd: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // What follows "--" (or -e) is the command run inside: its options are not wsl's.
    if (a === '--' || a === '-e' || a === '--exec') break;
    if ((a === '-d' || a === '--distribution') && args[i + 1] !== undefined) distro = args[++i]!;
    else if (a === '--cd' && args[i + 1] !== undefined) cd = args[++i]!;
  }
  return { distro, cd };
}

/** A Windows folder as the path it has inside the given WSL distribution, or null. */
export function toLinuxPath(windowsPath: string, distro: string): string | null {
  const p = windowsPath.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
  if (drive) return `/mnt/${drive[1]!.toLowerCase()}${(drive[2] ?? '').replace(/\/+$/, '')}`;
  const inside = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(p);
  if (inside) {
    if (inside[1]!.toLowerCase() !== distro.toLowerCase()) return null;
    return (inside[2] ?? '/').replace(/\/+$/, '') || '/';
  }
  return null;
}

export function editorTarget(session: { command: string; args: string[]; cwd: string }, askWsl: AskWsl): EditorTarget {
  const wsl = wslOf(session.command, session.args);
  if (!wsl) return { kind: 'local', path: session.cwd };

  let info: WslInfo | null | undefined;
  const ask = (): WslInfo | null => (info === undefined ? (info = askWsl(wsl.distro)) : info);

  const distro = wsl.distro ?? ask()?.distro ?? null;
  if (!distro) return { kind: 'error', message: 'Could not ask WSL which distribution this session runs in.' };

  // A folder given to wsl itself decides where the shell starts, whatever the session folder is.
  if (wsl.cd === '~') {
    const home = ask()?.home;
    return home ? { kind: 'wsl', distro, path: home } : { kind: 'error', message: 'Could not ask WSL for the home folder of this session.' };
  }
  if (wsl.cd?.startsWith('/')) return { kind: 'wsl', distro, path: wsl.cd };
  const path = toLinuxPath(wsl.cd ?? session.cwd, distro);
  return path ? { kind: 'wsl', distro, path } : { kind: 'error', message: 'The folder of this session cannot be reached from WSL.' };
}

/** The program and arguments that open VS Code on a target. */
export function codeLaunch(target: Exclude<EditorTarget, { kind: 'error' }>, code: string): { file: string; args: string[] } {
  if (target.kind === 'local') return { file: code, args: [target.path] };
  const path = target.path.split('/').map(encodeURIComponent).join('/');
  return { file: code, args: ['--folder-uri', `vscode-remote://wsl+${encodeURIComponent(target.distro)}${path}`] };
}

/** Asks a WSL distribution for its name and home folder. */
export function askWsl(distro: string | null): WslInfo | null {
  try {
    const out = execFileSync('wsl.exe', [...(distro ? ['-d', distro] : []), '--', 'sh', '-c', 'printf "%s\\n%s" "$WSL_DISTRO_NAME" "$HOME"'], {
      timeout: 8000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [name, home] = out.split('\n').map((l) => l.trim());
    return name && home?.startsWith('/') ? { distro: name, home } : null;
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * VS Code's own program. On Windows the `code` on PATH is a script beside it; the program is
 * started directly, so that a folder name never passes through a command interpreter.
 */
export function findCode(): string | null {
  const onPath = resolveExecutable('code');
  if (!onPath) return null;
  if (process.platform !== 'win32') return onPath;
  const exe = join(dirname(onPath), '..', 'Code.exe');
  return isFile(exe) ? exe : null;
}

/** Opens VS Code on the folder of a session. Returns an error message, or null when started. */
export function openInEditor(session: { command: string; args: string[]; cwd: string }): string | null {
  const code = findCode();
  if (!code) return 'VS Code was not found on this computer (the "code" command is not on the PATH).';
  const target = editorTarget(session, askWsl);
  if (target.kind === 'error') return target.message;
  const launch = codeLaunch(target, code);
  try {
    const child = spawn(launch.file, launch.args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => undefined);
    child.unref();
    return null;
  } catch (e) {
    return `VS Code could not be started: ${(e as Error).message}`;
  }
}
