import { useEffect, useRef } from 'react';

/**
 * The dialogs open now, the newest last. Escape closes only the newest: a dialog opened from
 * another one (Worktrees from New session, Switch branch from Worktrees) goes first.
 */
const stack: Array<{ close: () => void }> = [];
let listening = false;

/** Adds a dialog to the stack; the function returned takes it out again. */
export function pushEscape(close: () => void): () => void {
  const entry = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Closes the newest dialog on Escape. True when a dialog took the key. */
export function handleEscape(e: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>): boolean {
  if (e.key !== 'Escape') return false;
  const top = stack[stack.length - 1];
  if (!top) return false;
  e.preventDefault();
  e.stopPropagation();
  top.close();
  return true;
}

/**
 * Closes this dialog on Escape while it is the newest one open. The key is caught on its way
 * down (capture), so overlays that stop key events from bubbling do not hide it. With `open`
 * false it takes no key, for panels that stay mounted while closed (the sidebar drawer).
 */
export function useEscape(onClose: () => void, open = true): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (!listening) {
      listening = true;
      window.addEventListener('keydown', (e) => void handleEscape(e), true);
    }
    return pushEscape(() => latest.current());
  }, [open]);
}
