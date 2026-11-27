// What the page may ask of the desktop app: to show its window, after a click on one of its
// notifications (the window may be hidden in the tray, which the page cannot undo itself), and to
// bring forward the window of a session shown on its own. Nothing else crosses: no Node, no file system, no other message. CommonJS, as a sandboxed
// preload must be.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellyardDesktop', {
  showWindow: () => ipcRenderer.send('shellyard:show-window'),
  showDetached: (id) => ipcRenderer.send('shellyard:show-detached', String(id)),
});
