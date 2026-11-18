// The desktop app: a window on the ShellYard server. The server itself is the one `shellyard` starts, a
// background process that outlives the window, so closing the app never stops a session.
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, session, shell, Tray } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, pageAddress, restartServer, writeLauncherPage } from '@talentiaoss/shellyard/launcher';
import { findNode } from './find-node.js';

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

/** The icon in the notification area: the app keeps running there, and so do its notifications. */
function createTray() {
  if (tray) return;
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('ShellYard');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show ShellYard', click: showWindow },
      { label: 'Open in the browser', click: () => serverState && void shell.openPath(writeLauncherPage(serverState)) },
      { type: 'separator' },
      { label: 'Quit (sessions keep running)', click: () => app.quit() },
    ]),
  );
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
      new Notification({ title: 'ShellYard is still running', body: 'It stays in the notification area and tells you when a session needs you. Quit it from there.', icon }).show();
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
  app.setAppUserModelId('com.talentia.shellyard');
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  );
  app.whenReady().then(openWindow, (e) => {
    dialog.showErrorBox('ShellYard', String(e?.message ?? e));
    app.quit();
  });
  app.on('activate', showWindow);
  // The window is only hidden on close; the app ends from the tray menu.
  app.on('window-all-closed', () => {});
}
