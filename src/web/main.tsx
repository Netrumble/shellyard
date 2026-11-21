import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { newlyWaiting } from './attention.js';
import { notify, viewForSession } from './notify.js';
import { pickSound, playSound, shouldPlay } from './sounds.js';
import type { SessionInfo } from '../shared/types.js';
import { getState, noteDigest, onSessionsChange, refreshSounds, setView, startStore } from './store.js';
import { focusOn, splitForFocus } from './focus.js';
import './theme.css';

startStore();

// A session that starts waiting while the page is in the background raises a notification.
onSessionsChange((prev, next) => {
  // In focus, only what blocks a session interrupts; finished ones wait for the digest.
  const { interrupt: waiting, digest } = splitForFocus(newlyWaiting(prev, next), focusOn(getState().focus, Date.now()));
  noteDigest(digest.map((s) => s.id));
  for (const s of waiting) notify(s, () => setView(viewForSession(getState().sessions, s.id)), getState().sound);
  if (waiting.length > 0 && shouldPlay(document.hasFocus(), getState().sound)) void playEventSound(waiting);
});

/**
 * Reads the library first, as another tab may have changed a sound, its cut or the settings; but
 * waits for it only briefly, as a late sound is worse than one from the library already held.
 */
async function playEventSound(waiting: SessionInfo[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([refreshSounds(), new Promise((r) => (timer = setTimeout(r, 500)))]);
  clearTimeout(timer);
  const { stories, soundLibrary } = getState();
  await playSound(pickSound(waiting, stories, soundLibrary.settings) ?? null, soundLibrary.sounds);
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
