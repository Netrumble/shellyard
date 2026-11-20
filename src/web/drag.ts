import type { SessionInfo, Story } from '../shared/types.js';
import { moveInOrder, type Place } from './order.js';

/** What is being dragged: each drop target accepts only its own type. */
export const SESSION_DRAG = 'application/x-shellyard-session';
export const AREA_DRAG = 'application/x-shellyard-area';
export const LAUNCHER_DRAG = 'application/x-shellyard-launcher';

/** The new order after a drop, or null when the drop changes nothing. */
export function reorderTo(ids: string[], dragged: string, target: string, place: Place): string[] | null {
  const next = moveInOrder(ids, dragged, target, place);
  return next.length === ids.length && next.every((id, i) => id === ids[i]) ? null : next;
}

/** The items in the order of `ids`; items not listed keep their order after the listed ones. */
export function sortByIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  const listed = items.filter((x) => rank.has(x.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...listed, ...items.filter((x) => !rank.has(x.id))];
}

/** The area a session is shown in: null when it has none, or when its area was deleted. */
export function areaOf(session: SessionInfo, stories: Story[]): string | null {
  return session.storyId !== null && stories.some((s) => s.id === session.storyId) ? session.storyId : null;
}

/**
 * What a session drop does: `moveTo` (when present) is the area it goes to, null for none;
 * `order` (when present) is the new order of all the sessions.
 */
export interface SessionDrop {
  moveTo?: string | null;
  order?: string[];
}

/** A session dropped before or after another one; null when that changes nothing. */
export function sessionDropOnSession(sessions: SessionInfo[], stories: Story[], dragged: string, target: string, place: Place): SessionDrop | null {
  const from = sessions.find((s) => s.id === dragged);
  const to = sessions.find((s) => s.id === target);
  if (!from || !to || from === to) return null;
  const drop: SessionDrop = {};
  const area = areaOf(to, stories);
  if (areaOf(from, stories) !== area) drop.moveTo = area;
  const order = reorderTo(
    sessions.map((s) => s.id),
    dragged,
    target,
    place,
  );
  if (order) drop.order = order;
  return 'moveTo' in drop || order ? drop : null;
}

/** A session dropped on an area (its header or its list); null when it is already there. */
export function sessionDropOnArea(sessions: SessionInfo[], stories: Story[], dragged: string, storyId: string | null): SessionDrop | null {
  const from = sessions.find((s) => s.id === dragged);
  if (!from || areaOf(from, stories) === storyId) return null;
  return { moveTo: storyId };
}

/** The session list as it will be once the server has applied a drop. */
export function withSessionDrop(sessions: SessionInfo[], dragged: string, drop: SessionDrop): SessionInfo[] {
  let next = sessions;
  if (drop.moveTo !== undefined) {
    const moveTo = drop.moveTo;
    next = next.map((s) => (s.id === dragged ? { ...s, storyId: moveTo } : s));
  }
  return drop.order ? sortByIds(next, drop.order) : next;
}

/** What is being dragged right now (the drag data cannot be read before the drop). */
export interface Dragged {
  type: string;
  id: string;
}

let dragged: Dragged | null = null;

export function startDragged(type: string, id: string): void {
  dragged = { type, id };
}

export function endDragged(): void {
  dragged = null;
}

export function getDragged(): Dragged | null {
  return dragged;
}

/**
 * Whether a drop of the held item on a target would change nothing, so that no drop line shows.
 * `targetId` is the item the target stands for (hovering the dragged item itself); `skip` is a
 * further check on the dragged id (a session over its own area).
 */
export function dropChangesNothing(held: Dragged | null, type: string, targetId?: string, skip?: (id: string) => boolean): boolean {
  if (!held || held.type !== type) return false;
  return (targetId !== undefined && held.id === targetId) || (skip?.(held.id) ?? false);
}

/**
 * After a failed change: the snapshot to put back, or null when the store no longer holds the
 * optimistic value (a newer update arrived and must not be overwritten).
 */
export function restoreAfterFailure<T>(current: T, optimistic: T, snapshot: T): T | null {
  return current === optimistic ? snapshot : null;
}
