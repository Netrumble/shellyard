// Builds the Windows installer (a setup wizard) for the desktop app.
//
// The app depends on the main package, which in this repository is the folder above. Packing
// that folder as it is would pull the whole repository into the installer, development
// dependencies included. So the main package is built and packed with `npm pack`, exactly as it
// would be published, and installed into a clean staging folder together with the desktop
// files. electron-builder then packs the staging folder.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(desktop, '..');
const stage = join(desktop, '.installer');
const out = join(desktop, 'release');

function run(cwd, args) {
  console.log(`> npm ${args.join(' ')}`);
  // npm is a .cmd file on Windows: it needs a shell to start.
  return execFileSync('npm', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: true, encoding: 'utf8' });
}

run(root, ['run', 'build']);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const packed = JSON.parse(run(root, ['pack', '--json', '--pack-destination', JSON.stringify(stage)]))[0].filename;

for (const f of ['main.js', 'find-node.js', 'icon.png']) copyFileSync(join(desktop, f), join(stage, f));

const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(readFileSync(join(desktop, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
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
      dependencies: { '@talentiaoss/shellyard': `file:./${packed}` },
      devDependencies: { electron: electronVersion },
    },
    null,
    2,
  ),
);
// Only what runs: the main package and its own dependencies, not Electron (the builder adds it).
run(stage, ['install', '--omit=dev', '--no-audit', '--no-fund']);

const builder = join(desktop, 'node_modules', '.bin', 'electron-builder');
execFileSync(builder, ['--win', 'nsis', '--projectDir', JSON.stringify(stage), '--config', JSON.stringify(join(desktop, 'electron-builder.json')), `-c.directories.output=${JSON.stringify(out)}`], {
  stdio: 'inherit',
  shell: true,
});
console.log(`\nInstaller written to ${out}`);
