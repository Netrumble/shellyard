// Builds the installer of the desktop app for the system it runs on: on Windows a setup wizard
// (NSIS .exe), on macOS a disk image (.dmg) for the processor of the build machine. The server's
// native module (node-pty) is installed for that system and processor only, so each installer
// is built on the system it is for.
//
// The app depends on the main package, which in this repository is the folder above. Packing
// that folder as it is would pull the whole repository into the installer, development
// dependencies included. So the main package is built and packed with `npm pack`, exactly as it
// would be published, and laid into a clean staging folder together with the desktop files.
// electron-builder then packs the staging folder.
//
// The main package's dependencies are installed with `npm ci` from the repository's own
// lockfile, so the installer ships exactly the versions that were tested, never whatever the
// registry offers on the day of the build. A SHA-256 checksum is written next to the installer:
// it is not code-signed yet (on macOS only ad-hoc signed, which Apple Silicon requires to run
// at all), and the checksum is how a download can be checked.
//
// `--stage-only` prepares the staging folder and stops, to look at what would be packed.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRepoName } from '../updates.js';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '..');
const stage = join(desktop, '.installer');
const out = join(desktop, 'release');
const stageOnly = process.argv.includes('--stage-only');

/** What electron-builder makes on this system, and the files of the result. */
const TARGETS = {
  win32: { args: ['--win', 'nsis'], output: (version) => [`ShellYard-Setup-${version}.exe`] },
  darwin: { args: ['--mac', 'dmg', `--${process.arch}`], output: (version) => [`ShellYard-${version}-${process.arch}.dmg`] },
};
const target = TARGETS[process.platform];
if (!target && !stageOnly) throw new Error(`No installer is built on ${process.platform}: on Linux the desktop app is installed from npm.`);

function run(cwd, args) {
  console.log(`> npm ${args.join(' ')}`);
  // npm is a .cmd file on Windows: it needs a shell to start.
  return execFileSync('npm', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: true, encoding: 'utf8' });
}

/** The tar of Windows itself (bsdtar), not one from Git for Windows that misreads C:\ paths. */
function tarProgram() {
  return process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!existsSync(join(root, 'package-lock.json'))) throw new Error('package-lock.json is missing: the installer is built only from the locked dependencies.');

run(root, ['run', 'build']);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const packed = JSON.parse(run(root, ['pack', '--json', '--pack-destination', JSON.stringify(stage)]))[0].filename;

// The dependencies of the main package, exactly as locked: npm ci refuses to run if the
// lockfile and package.json disagree.
const deps = join(stage, '.deps');
mkdirSync(deps);
copyFileSync(join(root, 'package-lock.json'), join(deps, 'package-lock.json'));
// The manifest without its scripts: nothing of the repository's own runs during this install.
const { scripts: _scripts, ...manifest } = rootPkg;
writeFileSync(join(deps, 'package.json'), JSON.stringify(manifest, null, 2));
run(deps, ['ci', '--omit=dev', '--no-audit', '--no-fund']);
renameSync(join(deps, 'node_modules'), join(stage, 'node_modules'));
// npm's record of that install names a project that is not this one; npm reads the folder instead.
rmSync(join(stage, 'node_modules', '.package-lock.json'), { force: true });
rmSync(deps, { recursive: true, force: true });

// The main package itself, as published.
const mainPackage = join(stage, 'node_modules', ...rootPkg.name.split('/'));
mkdirSync(mainPackage, { recursive: true });
execFileSync(tarProgram(), ['-xzf', join(stage, packed), '-C', mainPackage, '--strip-components=1'], { stdio: 'inherit' });
rmSync(join(stage, packed), { force: true });

for (const f of ['main.js', 'preload.cjs', 'find-node.js', 'login-env.js', 'updates.js', 'icon.png']) copyFileSync(join(desktop, f), join(stage, f));
// A macOS app icon must be at least 512 pixels; sips, part of macOS, scales the one there is.
if (process.platform === 'darwin') execFileSync('sips', ['-z', '512', '512', join(stage, 'icon.png'), '--out', join(stage, 'icon-mac.png')], { stdio: 'ignore' });

const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const electronPkg = join(desktop, 'node_modules', 'electron', 'package.json');
const electronVersion = existsSync(electronPkg) ? JSON.parse(readFileSync(electronPkg, 'utf8')).version : null;
// Where "Check for updates…" looks for releases: SHELLYARD_UPDATE_REPO (owner/name, set by the
// workflow to the repository it runs in), else the app's default.
const updateRepo = process.env.SHELLYARD_UPDATE_REPO ?? '';
// The same rule as the app's: a name it would refuse must not pass the build silently.
if (updateRepo && !isRepoName(updateRepo)) throw new Error(`SHELLYARD_UPDATE_REPO must be owner/name, not "${updateRepo}".`);
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      author: 'Talentia Software',
      license: pkg.license,
      type: 'module',
      main: 'main.js',
      dependencies: { [rootPkg.name]: rootPkg.version },
      ...(updateRepo ? { shellyard: { updateRepo } } : {}),
      // Electron itself is not packed from here: the builder adds it.
      ...(electronVersion ? { devDependencies: { electron: electronVersion } } : {}),
    },
    null,
    2,
  ),
);

if (stageOnly) {
  console.log(`\nStaging folder ready at ${stage}`);
  process.exit(0);
}
if (!electronVersion) throw new Error('Electron is not installed in desktop/: run npm install there first.');

const builder = join(desktop, 'node_modules', '.bin', 'electron-builder');
// Never published from here: on CI electron-builder would otherwise try to on a tag.
execFileSync(builder, [...target.args, '--publish', 'never', '--projectDir', JSON.stringify(stage), '--config', JSON.stringify(join(desktop, 'electron-builder.json')), `-c.directories.output=${JSON.stringify(out)}`], {
  stdio: 'inherit',
  shell: true,
});

// The checksum of each installer, in the form `sha256sum -c` (`shasum -a 256 -c` on macOS) reads.
for (const name of target.output(pkg.version)) {
  const file = join(out, name);
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
  console.log(`\nInstaller written to ${file}\nSHA-256 ${sha256} (also in ${basename(file)}.sha256)`);
}
