import { describe, expect, it } from 'vitest';
import { codeLaunch, editorTarget, toLinuxPath, wslOf } from '../../src/server/editor.js';

const noWsl = (): null => null;

describe('wslOf', () => {
  it('recognises a session that runs in WSL, with its distribution and start folder', () => {
    expect(wslOf('wsl', ['-d', 'Ubuntu'])).toEqual({ distro: 'Ubuntu', cd: null });
    expect(wslOf('C:\\Windows\\System32\\wsl.exe', ['--distribution', 'Debian', '--cd', '~'])).toEqual({ distro: 'Debian', cd: '~' });
    expect(wslOf('WSL.EXE', ['--cd', '/srv/app', '--', 'bash', '-lic', 'claude'])).toEqual({ distro: null, cd: '/srv/app' });
  });
  it('stops reading options where the command of the session begins', () => {
    expect(wslOf('wsl', ['-d', 'Ubuntu', '--', 'tool', '--cd', '/elsewhere', '-d', 'Other'])).toEqual({ distro: 'Ubuntu', cd: null });
  });
  it('is nothing for any other program', () => {
    expect(wslOf('pwsh', [])).toBeNull();
    expect(wslOf('C:\\tools\\wsl-helper.exe', ['-d', 'Ubuntu'])).toBeNull();
  });
});

describe('toLinuxPath', () => {
  it('turns a Windows folder into where WSL shows it', () => {
    expect(toLinuxPath('C:\\repos\\My App', 'Ubuntu')).toBe('/mnt/c/repos/My App');
    expect(toLinuxPath('d:/work/', 'Ubuntu')).toBe('/mnt/d/work');
    expect(toLinuxPath('C:\\', 'Ubuntu')).toBe('/mnt/c');
  });
  it('turns the Windows address of a folder inside the distribution into its Linux path', () => {
    expect(toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\app', 'Ubuntu')).toBe('/home/me/app');
    expect(toLinuxPath('\\\\wsl$\\ubuntu\\home\\me', 'Ubuntu')).toBe('/home/me');
    expect(toLinuxPath('//wsl.localhost/Ubuntu', 'Ubuntu')).toBe('/');
  });
  it('gives nothing for a folder WSL cannot be pointed at', () => {
    expect(toLinuxPath('\\\\wsl.localhost\\Debian\\home\\me', 'Ubuntu')).toBeNull();
    expect(toLinuxPath('\\\\server\\share\\x', 'Ubuntu')).toBeNull();
    expect(toLinuxPath('relative\\path', 'Ubuntu')).toBeNull();
  });
});

describe('editorTarget', () => {
  it('opens the folder of an ordinary session as it is', () => {
    expect(editorTarget({ command: 'pwsh', args: [], cwd: 'C:\\repos\\app' }, noWsl)).toEqual({ kind: 'local', path: 'C:\\repos\\app' });
    expect(editorTarget({ command: 'claude', args: ['--verbose'], cwd: '/home/me/app' }, noWsl)).toEqual({ kind: 'local', path: '/home/me/app' });
  });
  it('opens the folder of a WSL session inside its distribution', () => {
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu'], cwd: 'C:\\repos\\app' }, noWsl)).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/mnt/c/repos/app' });
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu'], cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me' }, noWsl)).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me' });
  });
  it('follows the start folder given to wsl itself, which comes before the session folder', () => {
    const info = (): { distro: string; home: string } => ({ distro: 'Ubuntu', home: '/home/me' });
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu', '--cd', '/srv/app'], cwd: 'C:\\x' }, noWsl)).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/srv/app' });
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu', '--cd', '~'], cwd: 'C:\\x' }, info)).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me' });
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu', '--cd', 'D:\\data'], cwd: 'C:\\x' }, noWsl)).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/mnt/d/data' });
  });
  it('asks WSL which distribution is the default when the session names none', () => {
    const asked: Array<string | null> = [];
    const info = (d: string | null): { distro: string; home: string } => {
      asked.push(d);
      return { distro: 'Debian', home: '/home/me' };
    };
    expect(editorTarget({ command: 'wsl', args: [], cwd: 'C:\\repos\\app' }, info)).toEqual({ kind: 'wsl', distro: 'Debian', path: '/mnt/c/repos/app' });
    expect(asked).toEqual([null]);
  });
  it('says why when the folder cannot be worked out', () => {
    expect(editorTarget({ command: 'wsl', args: [], cwd: 'C:\\x' }, noWsl)).toEqual({ kind: 'error', message: 'Could not ask WSL which distribution this session runs in.' });
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu', '--cd', '~'], cwd: 'C:\\x' }, noWsl)).toEqual({ kind: 'error', message: 'Could not ask WSL for the home folder of this session.' });
    expect(editorTarget({ command: 'wsl', args: ['-d', 'Ubuntu'], cwd: '\\\\server\\share' }, noWsl)).toEqual({ kind: 'error', message: 'The folder of this session cannot be reached from WSL.' });
  });
});

describe('codeLaunch', () => {
  it('starts VS Code on a folder', () => {
    expect(codeLaunch({ kind: 'local', path: 'C:\\repos\\My App' }, 'C:\\VS\\Code.exe')).toEqual({ file: 'C:\\VS\\Code.exe', args: ['C:\\repos\\My App'] });
  });
  it('starts VS Code on a folder inside a WSL distribution', () => {
    expect(codeLaunch({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/my app#1' }, 'C:\\VS\\Code.exe')).toEqual({
      file: 'C:\\VS\\Code.exe',
      args: ['--folder-uri', 'vscode-remote://wsl+Ubuntu/home/me/my%20app%231'],
    });
    expect(codeLaunch({ kind: 'wsl', distro: 'Ubuntu-22.04', path: '/' }, 'code').args).toEqual(['--folder-uri', 'vscode-remote://wsl+Ubuntu-22.04/']);
  });
});
