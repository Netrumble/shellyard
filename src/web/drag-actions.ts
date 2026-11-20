import { api } from './api.js';
import { reorderTo, restoreAfterFailure, sessionDropOnArea, sessionDropOnSession, sortByIds, withSessionDrop, type SessionDrop } from './drag.js';
import type { Place } from './order.js';
import { applyLocally, getState, refreshMeta } from './store.js';

const report = (e: unknown): void => window.alert((e as Error).message);

/** True when dropping this session on that area (null: none) would change nothing. */
export function sessionInArea(id: string, storyId: string | null): boolean {
  const { sessions, stories } = getState();
  return sessionDropOnArea(sessions, stories, id, storyId) === null;
}

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
  const optimistic = sortByIds(stories, order);
  applyLocally({ stories: optimistic });
  api
    .reorderStories(order)
    .then((saved) => applyLocally({ stories: saved }))
    .catch((e) => {
      report(e);
      const back = restoreAfterFailure(getState().stories, optimistic, stories);
      if (back) applyLocally({ stories: back });
    });
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
  const snapshot = getState().sessions;
  const optimistic = withSessionDrop(snapshot, dragged, drop);
  applyLocally({ sessions: optimistic });
  const move = drop.moveTo !== undefined ? api.moveSession(dragged, drop.moveTo) : Promise.resolve();
  move
    .then(() => (drop.order ? api.reorderSessions(drop.order) : undefined))
    .catch((e) => {
      report(e);
      const back = restoreAfterFailure(getState().sessions, optimistic, snapshot);
      if (back) applyLocally({ sessions: back });
    });
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
