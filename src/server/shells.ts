import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Profile, SessionKind } from '../shared/types.js';

export interface Launch {
  file: string;
  /** A list of arguments, or on Windows a ready-made command line passed on untouched. */
  args: string[] | string;
}

type Env = Record<string, string | undefined>;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Environment variable lookup that ignores case, as Windows does (PATH is usually "Path"). */
function envGet(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k];
  return undefined;
}

function windowsExtensions(env: Env): string[] {
  const raw = envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((e) => e.trim()).filter(Boolean);
}

function candidates(base: string, env: Env, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [base];
  const exts = windowsExtensions(env);
  const hasKnownExt = exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()));
  // On Windows a bare name without an executable extension is not runnable (npm ships
  // an extensionless shell script next to every .cmd shim).
  if (hasKnownExt) return [base];
  const out: string[] = [];
  for (const e of exts) out.push(base + e, base + e.toLowerCase());
  return out;
}

/**
 * Finds the file a command name refers to. node-pty on Windows needs a real path:
 * it does not search PATH or apply PATHEXT the way a shell does.
 */
export function resolveExecutable(
  name: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!name) return null;
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    for (const c of candidates(name, env, platform)) if (isFile(c)) return c;
    return null;
  }
  const dirs = (envGet(env, 'PATH') || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const c of candidates(join(dir, name), env, platform)) if (isFile(c)) return c;
  }
  return null;
}

function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s&|<>^%()"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * A .cmd or .bat file is not an executable image; it has to be run by cmd.exe. The command
 * line is built here as a single string: with /s, cmd strips one pair of quotes around the
 * whole line and keeps the inner ones, which is the only form that survives a shim path or
 * an argument containing spaces (C:\Program Files\nodejs\claude.cmd).
 */
export function toLaunch(resolvedPath: string, args: string[], platform: NodeJS.Platform = process.platform): Launch {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath)) {
    const line = [`"${resolvedPath}"`, ...args.map(quoteForCmd)].join(' ');
    return { file: 'cmd.exe', args: `/d /s /c "${line}"` };
  }
  return { file: resolvedPath, args };
}

function profile(id: string, name: string, kind: SessionKind, command: string, color: string): Profile {
  return { id, name, kind, command, args: [], cwd: homedir(), color, env: {}, model: null };
}

/**
 * The distribution names in what `wsl.exe --list --quiet` prints: UTF-16, one name per line.
 * Docker's own distributions are left out (they are not for working in), and so is anything
 * that does not look like a name: without distributions wsl.exe prints a sentence instead.
 */
export function parseWslList(printed: Buffer): string[] {
  const names = printed
    .toString('utf16le')
    .replace(/\uFEFF/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n) && !/^docker-desktop/i.test(n));
  return [...new Set(names)];
}

const WSL_LIST_TTL_MS = 60_000;
let wslCache: { at: number; names: string[] } | null = null;

/**
 * The WSL distributions installed on this machine. Asking costs a process start and profiles
 * are listed often, so the answer is kept for a minute.
 */
export function listWslDistros(): string[] {
  const now = Date.now();
  if (wslCache && now - wslCache.at < WSL_LIST_TTL_MS) return wslCache.names;
  let names: string[] = [];
  try {
    names = parseWslList(execFileSync('wsl.exe', ['--list', '--quiet'], { timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // WSL is not set up, or did not answer in time: no WSL profiles this time.
  }
  wslCache = { at: now, names };
  return names;
}

/** The profiles CVM offers without any configuration: whatever is installed on this machine. */
export function detectProfiles(env: Env = process.env, platform: NodeJS.Platform = process.platform, wslDistros: () => string[] = listWslDistros): Profile[] {
  const found: Profile[] = [];
  const has = (cmd: string): boolean => resolveExecutable(cmd, env, platform) !== null;

  if (has('claude')) found.push(profile('builtin-claude', 'Claude Code', 'claude', 'claude', '#d97757'));

  if (platform === 'win32') {
    if (has('pwsh')) found.push(profile('builtin-pwsh', 'PowerShell 7', 'shell', 'pwsh', '#2f6fde'));
    if (has('powershell')) found.push(profile('builtin-powershell', 'Windows PowerShell', 'shell', 'powershell', '#1f4f9e'));
    if (has('cmd')) found.push(profile('builtin-cmd', 'Command Prompt', 'shell', 'cmd', '#7a7a7a'));
    const programFiles = envGet(env, 'ProgramFiles');
    if (programFiles) {
      const gitBash = join(programFiles, 'Git', 'bin', 'bash.exe');
      if (isFile(gitBash)) found.push(profile('builtin-gitbash', 'Git Bash', 'shell', gitBash, '#e8a33d'));
    }
    // One shell per WSL distribution. It starts in the session's folder, which WSL shows
    // under /mnt/<drive>, like any Windows folder.
    if (has('wsl')) {
      for (const name of wslDistros()) {
        const id = `builtin-wsl-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
        if (found.some((p) => p.id === id)) continue;
        found.push({ ...profile(id, `WSL: ${name}`, 'shell', 'wsl', '#12a594'), args: ['-d', name] });
      }
    }
  } else {
    const shell = envGet(env, 'SHELL');
    const shellPath = shell ? resolveExecutable(shell, env, platform) : null;
    if (shell && shellPath) found.push(profile('builtin-shell', `Shell (${shell.split('/').pop()})`, 'shell', shell, '#2f6fde'));
    const bashPath = resolveExecutable('bash', env, platform);
    // /bin is often a link to /usr/bin, so the same bash is reachable by two paths.
    if (bashPath && (!shellPath || realPath(bashPath) !== realPath(shellPath))) found.push(profile('builtin-bash', 'bash', 'shell', 'bash', '#e8a33d'));
  }
  return found;
}
