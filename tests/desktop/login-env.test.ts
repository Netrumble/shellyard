import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module of the desktop app, without types
import { adoptLoginPath, loginShellPath, mergePaths, parseMarkedPath } from '../../desktop/login-env.js';

describe('parseMarkedPath', () => {
  it('takes the PATH between the marks, whatever the profile printed around it', () => {
    const printed = 'Welcome!\n__SHELLYARD_PATH__\n/opt/homebrew/bin:/usr/bin\n__SHELLYARD_PATH__\nbye\n';
    expect(parseMarkedPath(printed)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('gives null without marks or with an empty PATH', () => {
    expect(parseMarkedPath('/usr/bin')).toBeNull();
    expect(parseMarkedPath('__SHELLYARD_PATH__\n\n__SHELLYARD_PATH__\n')).toBeNull();
  });
});

describe('mergePaths', () => {
  it('keeps the order, each folder once, and drops relative entries', () => {
    expect(mergePaths('/a:/b', null, '/b:.:/c:', '/a')).toBe('/a:/b:/c');
  });
});

describe('loginShellPath', () => {
  it("asks the user's shell as a login shell", () => {
    const run = vi.fn(() => '__SHELLYARD_PATH__\n/x/bin:/usr/bin\n__SHELLYARD_PATH__\n');
    expect(loginShellPath({ SHELL: '/bin/bash' }, run)).toBe('/x/bin:/usr/bin');
    expect(run).toHaveBeenCalledWith('/bin/bash', ['-ilc', expect.stringContaining('/usr/bin/printenv PATH')], expect.objectContaining({ timeout: 5000 }));
  });

  it('falls back to zsh when SHELL is missing or relative, and gives null when the shell fails', () => {
    const run = vi.fn((_file: string, _args: string[], _options: object): string => {
      throw new Error('timed out');
    });
    expect(loginShellPath({ SHELL: 'zsh' }, run)).toBeNull();
    expect(run.mock.calls[0]?.[0]).toBe('/bin/zsh');
  });
});

describe('adoptLoginPath', () => {
  const run = () => '__SHELLYARD_PATH__\n/Users/me/.nvm/bin:/usr/bin\n__SHELLYARD_PATH__\n';

  it('puts the login PATH first on macOS, then the old one and the usual folders', () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
    adoptLoginPath(env, 'darwin', run);
    expect(env.PATH).toBe('/Users/me/.nvm/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  });

  it('changes nothing elsewhere', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    adoptLoginPath(env, 'win32', run);
    adoptLoginPath(env, 'linux', run);
    expect(env.PATH).toBe('/usr/bin');
  });
});
