import type { ErrorReport, SessionInfo } from '../shared/types.js';
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

/** The digest at the end of a focus: one notification, if the page is not in view. */
export function notifyDigest(text: string, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  const n = new Notification('Focus ended', { body: text, tag: 'shellyard-focus-digest', silent: !sound });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

/** An unexpected error, with where its report is: one notification, if the page is not in view. */
export function notifyError(report: ErrorReport, onClick: () => void, sound: boolean): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  const title = report.source === 'page' ? 'ShellYard: the page hit an error' : 'ShellYard hit an error';
  const n = new Notification(title, { body: `${report.message}\nReport: ${report.file}`, tag: `shellyard-error-${report.id}`, silent: !sound });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}
