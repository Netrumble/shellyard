// The keyboard of the answer queue, kept free of the DOM so that it can be tested.

export type QueueAction = 'allow' | 'always' | 'deny' | 'reply' | 'next' | 'prev' | 'open';

export interface QueueContext {
  /** The focus is in a terminal or a field: the keys are text there. */
  typing: boolean;
  /** The focus is on a button: Enter presses it, and must not also open the terminal. */
  onButton: boolean;
  /** A dialog is open over the queue: its keys are its own, never an answer to what is behind it. */
  inDialog: boolean;
  /** Something is selected. */
  hasItem: boolean;
  /** The selected item is a permission request that can be answered from here. */
  answerable: boolean;
  /** "Always in this area" is available for it. */
  canAlways: boolean;
  /** Time since the selection last moved on by itself. */
  sinceAdvanceMs: number;
}

/**
 * After the queue moves on to the next request, the answer keys wait this long: a key pressed
 * twice, or pressed just as the next request appears, must not answer one nobody has read.
 */
export const SETTLE_MS = 600;

const KEYS: Record<string, QueueAction> = {
  a: 'allow',
  s: 'always',
  d: 'deny',
  r: 'reply',
  j: 'next',
  k: 'prev',
  arrowdown: 'next',
  arrowup: 'prev',
  enter: 'open',
};

const ANSWERS = new Set<QueueAction>(['allow', 'always', 'deny']);

export function queueAction(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean }, c: QueueContext): QueueAction | null {
  if (c.typing || c.inDialog || e.ctrlKey || e.altKey || e.metaKey) return null;
  const action = KEYS[e.key.toLowerCase()];
  if (!action) return null;
  if (action === 'next' || action === 'prev') return action;
  if (!c.hasItem) return null;
  if (action === 'open' && c.onButton) return null;
  if (ANSWERS.has(action)) {
    if (e.repeat || !c.answerable || c.sinceAdvanceMs < SETTLE_MS) return null;
    if (action === 'always' && !c.canAlways) return null;
  }
  return action;
}

/**
 * What is selected after the queue changed: the same item while it is there; else the one that
 * took its place (the next in line), or the new last one; the first when nothing was selected.
 */
export function nextSelection(prev: string[], next: string[], selected: string | null): string | null {
  if (next.length === 0) return null;
  if (selected !== null && next.includes(selected)) return selected;
  if (selected === null) return next[0]!;
  const at = prev.indexOf(selected);
  if (at < 0) return next[0]!;
  // The items that were after it, in the order they were: the first still there takes its place.
  for (const id of prev.slice(at + 1)) if (next.includes(id)) return id;
  return next[next.length - 1]!;
}

/** One item down (1) or up (-1), stopping at the ends. */
export function step(ids: string[], selected: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = selected === null ? -1 : ids.indexOf(selected);
  if (at < 0) return ids[0]!;
  return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]!;
}
