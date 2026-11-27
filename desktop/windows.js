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
