import type { SessionInfo } from '../shared/types.js';

/**
 * The ids to show as cards in the attention panel. Normally that is the waiting sessions in
 * their order. The card the user is typing in is the exception: it keeps the position it
 * had, even if its session has stopped waiting or others now sort ahead of it, so that a
 * card never disappears or moves under the user's hands. Once focus leaves, the next call
 * returns the plain order.
 */
export function visibleCards(attention: SessionInfo[], previous: string[], focusedId: string | null): string[] {
  const ids = attention.map((s) => s.id);
  if (focusedId === null) return ids;
  const heldAt = previous.indexOf(focusedId);
  if (heldAt < 0) return ids;
  const others = ids.filter((id) => id !== focusedId);
  others.splice(Math.min(heldAt, others.length), 0, focusedId);
  return others;
}

export function titleFor(count: number): string {
  return count > 0 ? `(${count}) TTC` : 'TTC';
}

/** Sessions that started waiting between two snapshots of the list. */
export function newlyWaiting(prev: SessionInfo[], next: SessionInfo[]): SessionInfo[] {
  const wasWaiting = new Set(prev.filter((s) => s.status === 'attention').map((s) => s.id));
  return next.filter((s) => s.status === 'attention' && !wasWaiting.has(s.id));
}

export function reasonLabel(s: SessionInfo): string {
  if (s.status === 'attention') {
    if (s.reason === 'finished') return 'Finished, awaiting prompt';
    if (s.reason === 'maybe-waiting') return 'Possibly waiting';
    return 'Permission or input needed';
  }
  if (s.status === 'working') return 'Working';
  if (s.status === 'idle') return 'Idle';
  if (s.status === 'running') return 'Running';
  return 'Exited';
}

export function elapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
