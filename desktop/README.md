# ShellYard desktop

ShellYard in its own window instead of a browser tab. It is the same app: the same server, the same
sessions, the same page.

On Windows the simplest way is the setup program: download `ShellYard-Setup-<version>.exe` from the
[latest release](https://github.com/Talentia-Software-OSS/shellyard/releases/latest) and run it.
Otherwise, from npm:

```
npm install -g @talentiaoss/shellyard-desktop
shellyard-desktop
```

The first start downloads Electron (about 100 MB). Node.js 22 or later must be on PATH: the
server runs on it, as with `shellyard`.

- The window attaches to the ShellYard server if one is running, and starts one in the background if
  not.
- Closing the window hides it: ShellYard stays in the notification area (the tray) and still tells you
  when a session needs you. Click the icon to bring the window back; its menu also opens ShellYard in
  the browser, or quits the app.
- **Quitting the app does not close your shells.** The server keeps running in the background with
  every shell and Claude Code session in it, until you close each one with its `✕` in ShellYard.
  `shellyard stop` stops the server too, but the sessions still open are started again at the next
  start: close in ShellYard the ones you no longer want.
- `shellyard` and `shellyard-desktop` can be used side by side: the browser and the window show the same
  sessions.
- `shellyard-desktop --port <n>` picks the port, as `shellyard --port` does.

## Development

From this folder, with the main package built (`npm run build` in the parent folder):

```
npm install --no-save ..
npm start
```

## Windows installer

```
npm run installer
```

builds `release/ShellYard-Setup-<version>.exe`, a setup wizard: it asks where to install, adds
ShellYard to the Start menu and the desktop, and registers an uninstaller in Windows' installed
apps. Node.js 22 or later must still be on PATH on the machine it is installed on. The installer
is not code-signed, so Windows warns about an unknown publisher on the first run.

The dependencies of the main package are installed with `npm ci` from the repository's
`package-lock.json`, so the installer holds exactly the locked versions. Next to the `.exe` the
build writes `ShellYard-Setup-<version>.exe.sha256`, its SHA-256 checksum.
`npm run installer -- --stage-only` prepares `.installer/`, the folder that would be packed, and
stops there.

To publish it, attach the `.exe` and its `.sha256` to a GitHub release whose tag matches the
version (`v0.1.0` for `0.1.0`):

```
gh release create v0.1.0 release/ShellYard-Setup-0.1.0.exe release/ShellYard-Setup-0.1.0.exe.sha256 --title "ShellYard 0.1.0" --notes "..."
```

The README links to the latest release, so the download link never needs updating.
