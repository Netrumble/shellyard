// Which new windows a ShellYard page may open inside the app. A session can be shown in a window
// of its own (the page on ?detached=<session id>): that window is the app's, with the same
// isolation as the main one. Every other address leaves the app for the browser.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the address of a session's own window on the server of this start. */
export function isDetachedWindowUrl(url, origin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!origin || u.origin !== origin || u.pathname !== '/') return false;
  const id = u.searchParams.get('detached');
  return id !== null && SESSION_ID.test(id) && [...u.searchParams.keys()].length === 1;
}

/** The session a window of the app shows on its own, or null for any other window. */
export function detachedSessionOf(url, origin) {
  return isDetachedWindowUrl(url, origin) ? new URL(url).searchParams.get('detached') : null;
}

/**
 * Brings a window to the front: shown if hidden, restored if minimised, then focused. The page
 * cannot do it itself, `window.focus()` on the window it opened leaves it behind or minimised.
 */
export function raise(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  win.focus();
}

/** How much of a window must be on a screen to be found and moved: a good part of its title bar. */
const GRIP_WIDTH = 120;
const GRIP_HEIGHT = 32;

/**
 * Where a session's window goes so that it can be seen: unchanged when its title bar is on one of
 * the screens' work areas, otherwise centred on `home` (the main window's screen) and no larger
 * than it. The page asks for the place the window was last, which may be on a monitor since
 * unplugged or (from an older version) where Windows puts a minimised window, -32000; a browser
 * pulls such a window back, the app has to.
 */
export function placeOnScreen(bounds, areas, home) {
  const grip = (a) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + GRIP_HEIGHT, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= Math.min(GRIP_WIDTH, bounds.width) && h >= Math.min(GRIP_HEIGHT, bounds.height);
  };
  if (areas.some(grip)) return bounds;
  const width = Math.min(bounds.width, home.width);
  const height = Math.min(bounds.height, home.height);
  return { x: Math.round(home.x + (home.width - width) / 2), y: Math.round(home.y + (home.height - height) / 2), width, height };
}
