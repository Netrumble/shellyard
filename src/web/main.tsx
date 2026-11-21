import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { newlyWaiting } from './attention.js';
import { notify, notifyError, notifyStuck } from './notify.js';
import { freshErrors, installPageErrorReporting } from './page-errors.js';
import { PageErrorBoundary } from './components/ErrorNotices.js';
import { newlyStuck, spanLabel } from './schedule-text.js';
import { pickSound, playSound, shouldPlay } from './sounds.js';
import type { SessionInfo } from '../shared/types.js';
import { getState, noteDigest, onErrorsChange, onSchedulesChange, onSessionsChange, refreshSounds, setView, startStore } from './store.js';
import { focusOn, splitForFocus } from './focus.js';
import './theme.css';

startStore();
// Errors nothing in the page caught are written to a report by the server, like its own.
installPageErrorReporting(() => getState().view.kind);

// An error while the page is in the background raises a notification that says where its report is.
onErrorsChange((prev, next) => {
  for (const r of freshErrors(prev, next).slice(0, 3)) notifyError(r, () => undefined, getState().sound);
});

// A session that starts waiting while the page is in the background raises a notification.
onSessionsChange((prev, next) => {
  // In focus, only what blocks a session interrupts; finished ones wait for the digest.
  const { interrupt: waiting, digest } = splitForFocus(newlyWaiting(prev, next), focusOn(getState().focus, Date.now()));
  noteDigest(digest.map((s) => s.id));
  for (const s of waiting) notify(s, () => setView({ kind: 'single', id: s.id }), getState().sound);
  if (waiting.length > 0 && shouldPlay(document.hasFocus(), getState().sound)) void playEventSound(waiting);
});

// A scheduled run that waits on the user too long is reported once, with a reminder.
onSchedulesChange((prev, next) => {
  for (const { schedule, run } of newlyStuck(prev, next)) {
    // From the server's clock alone: the browser's may be set otherwise.
    const waited = run.blockedSince !== null && run.stuckAt !== null ? spanLabel(run.stuckAt - run.blockedSince) : '';
    const open = (): void => setView(run.sessionId ? { kind: 'single', id: run.sessionId } : { kind: 'schedules' });
    notifyStuck(schedule.name, `The scheduled run has been waiting on you for ${waited}.`, `${schedule.id}-${run.at}`, open, getState().sound);
  }
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
      <PageErrorBoundary>
        <App />
      </PageErrorBoundary>
    </StrictMode>,
  );
}
