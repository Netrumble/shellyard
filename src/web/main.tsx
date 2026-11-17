import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { newlyWaiting } from './attention.js';
import { notify } from './notify.js';
import { chime } from './sound.js';
import { getState, onSessionsChange, setView, startStore } from './store.js';
import './theme.css';

startStore();

// A session that starts waiting while the page is in the background raises a notification.
onSessionsChange((prev, next) => {
  const waiting = newlyWaiting(prev, next);
  for (const s of waiting) notify(s, () => setView({ kind: 'single', id: s.id }), getState().sound);
  if (waiting.length > 0 && getState().sound) chime();
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
