import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProfiles, parseWslList, resolveExecutable, toLaunch } from '../../src/server/shells.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shellyard-shells-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function touch(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, '');
  return p;
}

describe('resolveExecutable', () => {
  it('tries PATHEXT extensions on Windows', () => {
    const p = touch('tool.cmd');
    expect(resolveExecutable('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase()).toBe(p.toLowerCase());
  });

  it('prefers the earlier PATHEXT extension', () => {
    touch('tool.cmd');
    const exe = touch('tool.exe');
    expect(resolveExecutable('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase()).toBe(exe.toLowerCase());
  });

  it('does not pick an extensionless script on Windows', () => {
    touch('tool');
    expect(resolveExecutable('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBeNull();
  });

  it('finds a name that already has its extension', () => {
    const p = touch('pwsh.exe');
    expect(resolveExecutable('pwsh.exe', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')?.toLowerCase()).toBe(p.toLowerCase());
  });

  it('reads the Path variable whatever its case', () => {
    const p = touch('tool.exe');
    expect(resolveExecutable('tool', { Path: dir, PATHEXT: '.EXE' }, 'win32')?.toLowerCase()).toBe(p.toLowerCase());
  });

  it('returns null when absent', () => {
    expect(resolveExecutable('tool', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBeNull();
    expect(resolveExecutable('tool', { PATH: dir }, 'linux')).toBeNull();
  });

  it('resolves a plain name on Linux', () => {
    const p = touch('tool');
    expect(resolveExecutable('tool', { PATH: dir }, 'linux')).toBe(p);
  });

  it('returns an existing absolute path as it is, and null for a missing one', () => {
    const p = touch('abs.exe');
    expect(resolveExecutable(p, { PATH: '' }, process.platform)).toBe(p);
    expect(resolveExecutable(join(dir, 'missing.exe'), { PATH: dir }, process.platform)).toBeNull();
  });

  it('does not resolve a folder', () => {
    mkdirSync(join(dir, 'tool'));
    expect(resolveExecutable('tool', { PATH: dir }, 'linux')).toBeNull();
  });
});

describe('toLaunch', () => {
  it('wraps a .cmd shim through cmd.exe on Windows, as one quoted command line', () => {
    expect(toLaunch('C:\\x\\claude.cmd', ['--v'], 'win32')).toEqual({
      file: 'cmd.exe',
      args: '/d /s /c ""C:\\x\\claude.cmd" --v"',
    });
  });
  it('quotes a shim path and arguments that contain spaces', () => {
    expect(toLaunch('C:\\Program Files\\nodejs\\claude.cmd', ['--settings', 'C:\\Users\\John Smith\\s.json', '--model', 'opus'], 'win32')).toEqual({
      file: 'cmd.exe',
      args: '/d /s /c ""C:\\Program Files\\nodejs\\claude.cmd" --settings "C:\\Users\\John Smith\\s.json" --model opus"',
    });
  });
  it('quotes arguments holding characters cmd would act on', () => {
    expect(toLaunch('C:\\x\\a.cmd', ['a&b', 'x|y', ''], 'win32').args).toBe('/d /s /c ""C:\\x\\a.cmd" "a&b" "x|y" """');
  });
  it('wraps a .BAT whatever its case', () => {
    expect(toLaunch('C:\\x\\run.BAT', [], 'win32').file).toBe('cmd.exe');
  });
  it('leaves an .exe alone on Windows', () => {
    expect(toLaunch('C:\\x\\pwsh.exe', ['-NoLogo'], 'win32')).toEqual({ file: 'C:\\x\\pwsh.exe', args: ['-NoLogo'] });
  });
  it('leaves everything alone on Linux', () => {
    expect(toLaunch('/usr/bin/claude', ['--v'], 'linux')).toEqual({ file: '/usr/bin/claude', args: ['--v'] });
  });
});

describe('detectProfiles', () => {
  it('returns only what resolves on Windows', () => {
    touch('pwsh.exe');
    const profiles = detectProfiles({ PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32');
    expect(profiles.map((p) => p.id)).toEqual(['builtin-pwsh']);
    expect(profiles[0]).toMatchObject({ kind: 'shell', name: 'PowerShell 7', args: [], model: null });
  });

  it('offers Claude Code as a claude-kind profile', () => {
    touch('claude.cmd');
    const profiles = detectProfiles({ PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32');
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: 'builtin-claude', kind: 'claude', command: 'claude' });
  });

  it('includes $SHELL and bash on Linux, without duplicates', () => {
    const zsh = touch('zsh');
    touch('bash');
    const profiles = detectProfiles({ PATH: dir, SHELL: zsh }, 'linux');
    expect(profiles.map((p) => p.command)).toEqual([zsh, 'bash']);
    const same = detectProfiles({ PATH: dir, SHELL: join(dir, 'bash') }, 'linux');
    expect(same).toHaveLength(1);
  });

  // Creating a symbolic link needs special rights on Windows; the case is a Linux one anyway.
  it.skipIf(process.platform === 'win32')('offers bash once when $SHELL reaches it through a linked folder', () => {
    // Typical Linux layout: /bin is a link to /usr/bin, SHELL=/bin/bash, PATH finds /usr/bin/bash.
    const real = join(dir, 'usr-bin');
    mkdirSync(real);
    writeFileSync(join(real, 'bash'), '');
    symlinkSync(real, join(dir, 'bin'));
    const profiles = detectProfiles({ PATH: real, SHELL: join(dir, 'bin', 'bash') }, 'linux');
    expect(profiles.map((p) => p.id)).toEqual(['builtin-shell']);
  });
});

describe('WSL profiles', () => {
  it('reads the distribution names from what wsl.exe prints (UTF-16, one per line)', () => {
    const printed = Buffer.from('﻿Ubuntu\r\nDebian\r\n\r\ndocker-desktop\r\ndocker-desktop-data\r\nUbuntu\r\n', 'utf16le');
    expect(parseWslList(printed)).toEqual(['Ubuntu', 'Debian']);
    expect(parseWslList(Buffer.alloc(0))).toEqual([]);
  });

  it('refuses names that could not be a distribution', () => {
    const printed = Buffer.from('Ubuntu-22.04\r\nWindows Subsystem for Linux has no installed distributions.\r\n-d\r\n', 'utf16le');
    expect(parseWslList(printed)).toEqual(['Ubuntu-22.04']);
  });

  it('offers one shell profile per distribution when wsl.exe is there', () => {
    touch('pwsh.exe');
    touch('wsl.exe');
    const profiles = detectProfiles({ PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32', () => ['Ubuntu', 'Debian 12']);
    expect(profiles.map((p) => p.id)).toEqual(['builtin-pwsh', 'builtin-wsl-ubuntu', 'builtin-wsl-debian-12']);
    expect(profiles[1]).toMatchObject({ kind: 'shell', name: 'WSL: Ubuntu', command: 'wsl', args: ['-d', 'Ubuntu'], model: null });
    expect(profiles[2]).toMatchObject({ name: 'WSL: Debian 12', args: ['-d', 'Debian 12'] });
  });

  it('does not ask for distributions without wsl.exe, nor outside Windows', () => {
    touch('pwsh.exe');
    let asked = 0;
    const lister = (): string[] => {
      asked++;
      return ['Ubuntu'];
    };
    expect(detectProfiles({ PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32', lister).map((p) => p.id)).toEqual(['builtin-pwsh']);
    touch('wsl');
    touch('bash');
    expect(detectProfiles({ PATH: dir }, 'linux', lister).map((p) => p.id)).toEqual(['builtin-bash']);
    expect(asked).toBe(0);
  });
});
