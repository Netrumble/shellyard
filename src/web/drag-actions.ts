import { api } from './api.js';
import { reorderTo, sessionDropOnArea, sessionDropOnSession, sortByIds, withSessionDrop, type SessionDrop } from './drag.js';
import type { Place } from './order.js';
import { applyLocally, getState, refreshMeta } from './store.js';

const report = (e: unknown): void => window.alert((e as Error).message);

/** An area dropped before or after another one. */
export function dropArea(dragged: string, target: string, place: Place): void {
  const { stories } = getState();
  const order = reorderTo(
    stories.map((s) => s.id),
    dragged,
    target,
    place,
  );
  if (!order) return;
  applyLocally({ stories: sortByIds(stories, order) });
  api.reorderStories(order).catch(report);
}

/** A launcher dropped before or after another one; the list is read again either way. */
export function dropLauncher(dragged: string, target: string, place: Place): void {
  const { profiles } = getState().meta;
  const order = reorderTo(
    profiles.map((p) => p.id),
    dragged,
    target,
    place,
  );
  if (!order) return;
  applyLocally({ profiles: sortByIds(profiles, order) });
  api
    .reorderProfiles(order)
    .catch(report)
    .finally(() => void refreshMeta());
}

function sendSessionDrop(dragged: string, drop: SessionDrop | null): void {
  if (!drop) return;
  applyLocally({ sessions: withSessionDrop(getState().sessions, dragged, drop) });
  const move = drop.moveTo !== undefined ? api.moveSession(dragged, drop.moveTo) : Promise.resolve();
  move.then(() => (drop.order ? api.reorderSessions(drop.order) : undefined)).catch(report);
}

/** A session dropped before or after another one, moving into that one's area if needed. */
export function dropSessionOnSession(dragged: string, target: string, place: Place): void {
  const { sessions, stories } = getState();
  sendSessionDrop(dragged, sessionDropOnSession(sessions, stories, dragged, target, place));
}

/** A session dropped on an area; `storyId` null is "No area". */
export function dropSessionOnArea(dragged: string, storyId: string | null): void {
  const { sessions, stories } = getState();
  sendSessionDrop(dragged, sessionDropOnArea(sessions, stories, dragged, storyId));
}
