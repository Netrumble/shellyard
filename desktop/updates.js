// Finds out whether a newer ShellYard has been released on GitHub. Nothing is asked of GitHub
// unless the user chooses "Check for updates…" or turns on the automatic check: ShellYard sends
// nothing to the internet by itself. A newer version is offered as a download in the browser;
// the app never installs anything by itself.

/** The repository whose releases are checked, when the build did not name one. */
export const DEFAULT_UPDATE_REPO = 'Talentia-Software-OSS/shellyard';

/** A day: how often the automatic check runs while the app is open. */
export const AUTO_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** The three numbers of a version ("v0.2.1" or "0.2.1"), or null for anything else, pre-releases included. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a later version than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Whether a repository name is plain "owner/name". */
export function isRepoName(repo) {
  return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.split('/').some((part) => /^\.+$/.test(part));
}

/** Only GitHub's own pages and downloads are ever opened. */
function githubUrl(u) {
  return typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : null;
}

/**
 * The installer of a release for this system and processor: the setup program on Windows, the
 * disk image of the processor on macOS. Null when there is none (Linux: the app comes from npm).
 */
export function pickInstaller(assets, platform, arch) {
  const list = Array.isArray(assets) ? assets : [];
  const match =
    platform === 'win32' ? (n) => /^ShellYard-Setup-.*\.exe$/.test(n) : platform === 'darwin' ? (n) => new RegExp(`^ShellYard-.*-${arch}\\.dmg$`).test(n) : () => false;
  const asset = list.find((a) => typeof a?.name === 'string' && match(a.name));
  const url = githubUrl(asset?.browser_download_url);
  return asset && url ? { name: asset.name, url } : null;
}

/**
 * What GitHub's "latest release" answer means for this app: the newer version and where to get
 * it, or null when this app is up to date (or the answer is not a usable release).
 */
export function updateFrom(release, current, platform, arch) {
  const version = parseVersion(release?.tag_name);
  if (!version || release?.draft || release?.prerelease || !isNewer(release.tag_name, current)) return null;
  const page = githubUrl(release.html_url);
  if (!page) return null;
  return { version: version.join('.'), page, installer: pickInstaller(release.assets, platform, arch) };
}

/**
 * Asks GitHub for the latest release of `repo`. Resolves to the update, or null when this app is
 * up to date; rejects with a message to show when GitHub could not be asked.
 */
export async function checkForUpdate({ repo, current, platform = process.platform, arch = process.arch, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!isRepoName(repo)) throw new Error(`"${repo}" is not a repository name.`);
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ShellYard-desktop' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`GitHub could not be reached: ${e?.message ?? e}`);
  }
  if (res.status === 404) return null; // no release yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return updateFrom(await res.json(), current, platform, arch);
}
