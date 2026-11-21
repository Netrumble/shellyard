// The desktop app: a window on the ShellYard server. The server itself is the one `shellyard` starts, a
// background process that outlives the window, so closing the app never stops a session.
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, pageAddress, restartServer, writeLauncherPage } from '@talentiaoss/shellyard/launcher';
import { findNode } from './find-node.js';
import { adoptLoginPath } from './login-env.js';
import { AUTO_CHECK_EVERY_MS, checkForUpdate, DEFAULT_UPDATE_REPO, isRepoName } from './updates.js';

const isMac = process.platform === 'darwin';
// Opened from the Finder or the Dock, the app has the bare PATH of launchd: node, claude and
// code are found only with the PATH of the user's shell, which the server then inherits.
adoptLoginPath();

const here = dirname(fileURLToPath(import.meta.url));
const icon = nativeImage.createFromPath(join(here, 'icon.png'));
let win = null;
let tray = null;
let serverState = null;
/** True once the user asked to quit: until then closing the window only hides it. */
let quitting = false;
let toldAboutTray = false;

function showWindow() {
  if (!win) return void openWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// --- Updates -------------------------------------------------------------------------------
// GitHub is asked for a newer release only when the user chooses "Check for updates…", or after
// turning on the automatic check (off unless chosen). A newer version is offered as a download
// in the browser: the app never installs anything by itself.

/** The repository whose releases are checked: named by the build, else the main one. */
function updateRepo() {
  try {
    const named = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))?.shellyard?.updateRepo;
    return isRepoName(named) ? named : DEFAULT_UPDATE_REPO;
  } catch {
    return DEFAULT_UPDATE_REPO;
  }
}

const settingsFile = () => join(app.getPath('userData'), 'desktop-settings.json');

/** The app's own choices, kept beside its other data: whether to check by itself, and the version last notified. */
function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    return { autoCheckUpdates: raw?.autoCheckUpdates === true, notifiedVersion: typeof raw?.notifiedVersion === 'string' ? raw.notifiedVersion : null };
  } catch {
    return { autoCheckUpdates: false, notifiedVersion: null };
  }
}

function writeSettings(patch) {
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
  } catch (e) {
    console.error('ShellYard: could not save the settings:', e);
  }
}

/** The check under way, if any: a check asked for by hand waits for it, then asks again. */
let checking = null;
/**
 * The notification of a new version, kept until it is clicked or closed: Electron drops the
 * click handler of a notification nothing refers to any more.
 */
let updateNotification = null;
let firstCheck = null;
let dailyCheck = null;

/** Tells about a newer version and offers to get it. */
async function offerUpdate(update) {
  const buttons = [...(update.installer ? ['Download'] : []), 'Release page', 'Later'];
  const how = update.installer
    ? `Download opens ${update.installer.name} in your browser. Install it as the first time; your sessions keep running.`
    : 'The release page says how to get it.';
  const again = isMac ? ' The new app has to be allowed once, as the first time (see the release page).' : '';
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update available',
    message: `ShellYard ${update.version} is available`,
    detail: `You have ${app.getVersion()}. ${how}${again}`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
    icon: icon.isEmpty() ? undefined : icon,
  });
  if (buttons[response] === 'Download') void shell.openExternal(update.installer.url);
  if (buttons[response] === 'Release page') void shell.openExternal(update.page);
}

/**
 * Asks GitHub whether a newer version is out. Asked by the user, it always answers; by the
 * automatic check, it says so once per version, as a notification, and keeps quiet otherwise.
 */
async function checkUpdates({ manual }) {
  // The automatic check is not repeated while one is under way; one asked for by hand waits for
  // it and then answers, so that asking always gets an answer.
  if (checking && !manual) return;
  const previous = checking;
  const mine = (async () => {
    if (previous) await previous.catch(() => undefined);
    await runCheck(manual);
  })();
  checking = mine;
  try {
    await mine;
  } finally {
    if (checking === mine) checking = null;
  }
}

async function runCheck(manual) {
  try {
    const update = await checkForUpdate({ repo: updateRepo(), current: app.getVersion() });
    if (!update) {
      if (manual) await dialog.showMessageBox({ type: 'info', title: 'ShellYard', message: `ShellYard ${app.getVersion()} is the latest version.`, buttons: ['OK'], noLink: true });
      return;
    }
    if (!manual) {
      if (readSettings().notifiedVersion === update.version) return;
      if (Notification.isSupported()) {
        const n = new Notification({ title: `ShellYard ${update.version} is available`, body: 'Click to see how to get it.', icon });
        updateNotification = n;
        const forget = () => {
          if (updateNotification === n) updateNotification = null;
        };
        // Counted as announced once it is shown or clicked, not when it is only asked for: the
        // system may not show it (notifications turned off, Focus), and the next check tries again.
        const announced = () => writeSettings({ notifiedVersion: update.version });
        n.once('show', announced);
        n.on('click', () => {
          announced();
          forget();
          void offerUpdate(update);
        });
        n.on('close', forget);
        n.show();
        return;
      }
      // Without notifications the dialog says it, and is seen: once per version is enough.
      writeSettings({ notifiedVersion: update.version });
    }
    await offerUpdate(update);
  } catch (e) {
    if (manual) await dialog.showMessageBox({ type: 'warning', title: 'ShellYard', message: 'Could not check for updates', detail: String(e?.message ?? e), buttons: ['OK'], noLink: true });
    else console.error('ShellYard: the update check failed:', e);
  }
}

/** Starts or stops the automatic check: a little after the start, then once a day. */
function scheduleAutoCheck() {
  clearTimeout(firstCheck);
  clearInterval(dailyCheck);
  firstCheck = dailyCheck = null;
  if (!readSettings().autoCheckUpdates) return;
  firstCheck = setTimeout(() => void checkUpdates({ manual: false }), 10_000);
  dailyCheck = setInterval(() => void checkUpdates({ manual: false }), AUTO_CHECK_EVERY_MS);
}

/** The two update items, in the tray menu and in the app's menu. */
function updateMenuItems() {
  return [
    { label: 'Check for updates…', click: () => void checkUpdates({ manual: true }) },
    {
      label: 'Check for updates automatically',
      type: 'checkbox',
      checked: readSettings().autoCheckUpdates,
      click: (item) => {
        writeSettings({ autoCheckUpdates: item.checked });
        scheduleAutoCheck();
        buildMenus();
      },
    },
  ];
}

/** The app's menu bar, and the tray's menu once the tray is there. */
function buildMenus() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // On macOS the first menu is the app's own: About, updates, Hide, Quit (Cmd+Q).
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                { type: 'separator' },
                ...updateMenuItems(),
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
      ...(isMac ? [] : [{ label: 'Help', submenu: [...updateMenuItems(), { type: 'separator' }, { label: `ShellYard ${app.getVersion()}`, enabled: false }] }]),
    ]),
  );
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show ShellYard', click: showWindow },
      { label: 'Open in the browser', click: () => serverState && void shell.openPath(writeLauncherPage(serverState)) },
      { type: 'separator' },
      ...updateMenuItems(),
      { type: 'separator' },
      { label: 'Quit (sessions keep running)', click: () => app.quit() },
    ]),
  );
}

/** The icon in the notification area: the app keeps running there, and so do its notifications. */
function createTray() {
  if (tray) return;
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('ShellYard');
  buildMenus();
  tray.on('click', showWindow);
}

function portFromArgs(argv) {
  const i = argv.indexOf('--port');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

/**
 * The server already running is another version, usually the one before an update: its files
 * may be gone, and its page broken. Restarting it is the user's call, because whatever runs in
 * the open sessions ends (the sessions themselves are started again).
 */
async function offerRestart(started, node) {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'ShellYard was updated',
    message: 'ShellYard was updated. Restart its server to use the new version?',
    detail:
      `The server running now is ${started.serverVersion ? `version ${started.serverVersion}` : 'from an earlier version'}; ` +
      `this app is version ${started.appVersion}. Until it is restarted, the page may not work.\n\n` +
      'Restarting starts your open shells and Claude Code sessions again, but anything running in them now (a command, an answer being written) is stopped.',
    buttons: ['Restart now', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    icon: icon.isEmpty() ? undefined : icon,
  });
  if (response !== 0) return started;
  return restartServer({ port: started.state.port, node });
}

async function openWindow() {
  const node = findNode();
  if (!node) {
    dialog.showErrorBox('ShellYard', 'Node.js was not found on PATH. ShellYard runs its server on Node 22 or later: install it, then start the app again.');
    app.quit();
    return;
  }
  let started = await ensureServer({ port: portFromArgs(process.argv), node });
  if (started.ok && started.outdated) started = await offerRestart(started, node);
  if (!started.ok) {
    dialog.showErrorBox('ShellYard did not start', started.error);
    app.quit();
    return;
  }
  serverState = started.state;
  // The page's own host name of this start (<random>.localhost), never a fixed address.
  const origin = pageAddress(started.state);

  // A session of the app's own, not the default one, emptied before every load: a service
  // worker left by whatever answered on a ShellYard address while the server was down (another
  // user's program can take a free port) would answer instead of the server and read the
  // token. The page's address changes at every start, so what earlier ones stored is of no use.
  const ses = session.fromPartition('shellyard');
  await ses.clearStorageData();

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'ShellYard',
    icon: icon.isEmpty() ? undefined : icon,
    autoHideMenuBar: true,
    backgroundColor: '#181b21',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: ses },
  });

  // Links leave the app for the browser; the window itself stays on the server.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin === origin) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // Closing hides the window: the page stays loaded, so a session that needs you still
  // raises a notification. Quitting is in the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      const body = isMac
        ? 'It stays in the menu bar and tells you when a session needs you. Quit it from there, or with Cmd+Q.'
        : 'It stays in the notification area and tells you when a session needs you. Quit it from there.';
      new Notification({ title: 'ShellYard is still running', body, icon }).show();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  createTray();

  // The token travels in the fragment, as with the browser: no server sees it in a request line.
  await win.loadURL(`${origin}/#token=${started.state.token}`);
}

// One window is enough: a second start brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  // Windows shows notifications only for an app with an id.
  if (process.platform === 'win32') app.setAppUserModelId('com.talentia.shellyard');
  app.whenReady().then(() => {
    // The app's menu reads the saved settings, which live in a folder known only once ready.
    buildMenus();
    scheduleAutoCheck();
    return openWindow();
  }, (e) => {
    dialog.showErrorBox('ShellYard', String(e?.message ?? e));
    app.quit();
  });
  app.on('activate', showWindow);
  // The window is only hidden on close; the app ends from the tray menu.
  app.on('window-all-closed', () => {});
}
