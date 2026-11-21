import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module of the desktop app, without types
import { checkForUpdate, isNewer, isRepoName, parseVersion, pickInstaller, updateFrom } from '../../desktop/updates.js';

const assets = [
  { name: 'ShellYard-0.2.3-arm64.dmg', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.3/ShellYard-0.2.3-arm64.dmg' },
  { name: 'ShellYard-0.2.3-arm64.dmg.sha256', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.3/ShellYard-0.2.3-arm64.dmg.sha256' },
  { name: 'ShellYard-0.2.3-x64.dmg', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.3/ShellYard-0.2.3-x64.dmg' },
  { name: 'ShellYard-Setup-0.2.3.exe', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.3/ShellYard-Setup-0.2.3.exe' },
  { name: 'ShellYard-Setup-0.2.3.exe.sha256', browser_download_url: 'https://github.com/o/r/releases/download/v0.2.3/ShellYard-Setup-0.2.3.exe.sha256' },
];
const release = { tag_name: 'v0.2.3', html_url: 'https://github.com/o/r/releases/tag/v0.2.3', draft: false, prerelease: false, assets };

describe('versions', () => {
  it('reads three numbers, with or without v, and nothing else', () => {
    expect(parseVersion('v0.2.10')).toEqual([0, 2, 10]);
    expect(parseVersion('1.0.0')).toEqual([1, 0, 0]);
    expect(parseVersion('v0.3.0-beta')).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it('compares number by number', () => {
    expect(isNewer('v0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('v0.3.0', '0.2.99')).toBe(true);
    expect(isNewer('v0.2.1', '0.2.1')).toBe(false);
    expect(isNewer('v0.2.0', '0.2.1')).toBe(false);
    expect(isNewer('nightly', '0.2.1')).toBe(false);
  });
});

describe('isRepoName', () => {
  it('accepts owner/name only', () => {
    expect(isRepoName('Talentia-Software-OSS/shellyard')).toBe(true);
    expect(isRepoName('o/r/x')).toBe(false);
    expect(isRepoName('../x')).toBe(false);
    expect(isRepoName('')).toBe(false);
  });
});

describe('pickInstaller', () => {
  it('picks the setup program on Windows and the disk image of the processor on macOS', () => {
    expect(pickInstaller(assets, 'win32', 'x64')?.name).toBe('ShellYard-Setup-0.2.3.exe');
    expect(pickInstaller(assets, 'darwin', 'arm64')?.name).toBe('ShellYard-0.2.3-arm64.dmg');
    expect(pickInstaller(assets, 'darwin', 'x64')?.name).toBe('ShellYard-0.2.3-x64.dmg');
  });

  it('has nothing for Linux, for a missing file, or for a download outside GitHub', () => {
    expect(pickInstaller(assets, 'linux', 'x64')).toBeNull();
    expect(pickInstaller(assets.slice(0, 2), 'darwin', 'x64')).toBeNull();
    expect(pickInstaller([{ name: 'ShellYard-Setup-0.2.3.exe', browser_download_url: 'https://evil.example/x.exe' }], 'win32', 'x64')).toBeNull();
  });
});

describe('updateFrom', () => {
  it('offers a later release with its page and installer', () => {
    expect(updateFrom(release, '0.2.1', 'darwin', 'arm64')).toEqual({
      version: '0.2.3',
      page: 'https://github.com/o/r/releases/tag/v0.2.3',
      installer: { name: 'ShellYard-0.2.3-arm64.dmg', url: assets[0]!.browser_download_url },
    });
  });

  it('offers nothing when up to date, for drafts and pre-releases, or for a page outside GitHub', () => {
    expect(updateFrom(release, '0.2.3', 'darwin', 'arm64')).toBeNull();
    expect(updateFrom({ ...release, draft: true }, '0.2.1', 'darwin', 'arm64')).toBeNull();
    expect(updateFrom({ ...release, prerelease: true }, '0.2.1', 'darwin', 'arm64')).toBeNull();
    expect(updateFrom({ ...release, html_url: 'https://evil.example/' }, '0.2.1', 'darwin', 'arm64')).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }));

  it("asks for the repository's latest release and gives the update", async () => {
    const fetchImpl = answer(200, release);
    const u = await checkForUpdate({ repo: 'o/r', current: '0.2.1', platform: 'win32', arch: 'x64', fetchImpl });
    expect(u?.version).toBe('0.2.3');
    expect(u?.installer?.name).toBe('ShellYard-Setup-0.2.3.exe');
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/o/r/releases/latest', expect.objectContaining({ headers: expect.objectContaining({ 'user-agent': 'ShellYard-desktop' }) }));
  });

  it('gives null when the repository has no release yet', async () => {
    expect(await checkForUpdate({ repo: 'o/r', current: '0.2.1', fetchImpl: answer(404, {}) })).toBeNull();
  });

  it('says why when GitHub cannot be asked, and refuses a bad repository name', async () => {
    await expect(checkForUpdate({ repo: 'o/r', current: '0.2.1', fetchImpl: answer(500, {}) })).rejects.toThrow(/500/);
    const down = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    await expect(checkForUpdate({ repo: 'o/r', current: '0.2.1', fetchImpl: down })).rejects.toThrow(/could not be reached.*ENOTFOUND/);
    await expect(checkForUpdate({ repo: 'not a repo', current: '0.2.1', fetchImpl: down })).rejects.toThrow(/not a repository/);
    expect(down).toHaveBeenCalledTimes(1);
  });
});
