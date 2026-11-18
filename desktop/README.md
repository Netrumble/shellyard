# TTC desktop

TTC in its own window instead of a browser tab. It is the same app: the same server, the same
sessions, the same page.

```
npm install -g talentia-terminal-control-desktop
ttc-desktop
```

The first start downloads Electron (about 100 MB). Node.js 22 or later must be on PATH: the
server runs on it, as with `ttc`.

- The window attaches to the TTC server if one is running, and starts one in the background if
  not.
- Closing the window hides it: TTC stays in the notification area (the tray) and still tells you
  when a session needs you. Click the icon to bring the window back; its menu also opens TTC in
  the browser, or quits the app. Quitting does not stop the server or any session; `ttc stop`
  does.
- `ttc` and `ttc-desktop` can be used side by side: the browser and the window show the same
  sessions.
- `ttc-desktop --port <n>` picks the port, as `ttc --port` does.

## Development

From this folder, with the main package built (`npm run build` in the parent folder):

```
npm install --no-save ..
npm start
```
