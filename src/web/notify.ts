import type { SessionInfo } from '../shared/types.js';
import { reasonLabel } from './attention.js';

let asked = false;

/** Asks for notification permission once, at a moment the user has just done something. */
export function requestPermissionOnce(): void {
  if (asked || typeof Notification === 'undefined') return;
  asked = true;
  if (Notification.permission === 'default') void Notification.requestPermission();
}

/**
 * Shows a system notification, but only when the page is not what the user is looking at.
 * The system plays its own sound with a notification unless told not to: with Sound off it
 * is told not to.
 */
export function notify(s: SessionInfo, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  const n = new Notification(s.name, { body: reasonLabel(s), tag: `shellyard-${s.id}`, silent: !sound });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}
