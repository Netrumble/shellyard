import type { ConversationItem, CreateSessionRequest, FolderListing, Meta, Profile, Schedule, ScheduleRun, SessionInfo, Story, TerminalBackground, TerminalFont } from '../shared/types.js';

/** What a schedule is made or changed with; a change sends only the fields it changes. */
export type ScheduleFields = Partial<Pick<Schedule, 'name' | 'prompt' | 'profileId' | 'model' | 'cwd' | 'storyId' | 'when' | 'enabled' | 'catchUp' | 'permissionMode'>>;

export interface StoryFields {
  name: string;
  ticket: string;
  cwd: string;
  color: string;
}

let token = '';
let onUnauthorized: () => void = () => {};

/** The page holds the token and sends it on every call; the browser never sends it by itself. */
export function configureApi(opts: { token: string; onUnauthorized: () => void }): void {
  token = opts.token;
  onUnauthorized = opts.onUnauthorized;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? { 'x-ttc-token': token } : { 'x-ttc-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // Not a JSON error body; the status line will do.
    }
    throw new Error(message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const imageUrls = new Map<string, Promise<string>>();

/**
 * A URL the page can draw a stored background image from. The image is fetched with the
 * token (a plain image address could not carry it) and handed over as a local object URL.
 */
export function backgroundUrl(name: string): Promise<string> {
  let url = imageUrls.get(name);
  if (!url) {
    url = fetch(`/api/backgrounds/${encodeURIComponent(name)}`, { headers: { 'x-ttc-token': token } }).then(async (res) => {
      if (!res.ok) throw new Error(`Could not load the background image (${res.status}).`);
      return URL.createObjectURL(await res.blob());
    });
    url.catch(() => imageUrls.delete(name));
    imageUrls.set(name, url);
  }
  return url;
}

/** Sends an image file to be kept as a terminal background; returns the name it was given. */
export async function uploadBackground(file: File): Promise<string> {
  const res = await fetch('/api/backgrounds', { method: 'POST', headers: { 'x-ttc-token': token, 'content-type': 'application/octet-stream' }, body: file });
  if (res.status === 401) onUnauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // The status line will do.
    }
    throw new Error(message);
  }
  return ((await res.json()) as { image: string }).image;
}

export const api = {
  meta: (): Promise<Meta> => call('GET', '/api/meta'),
  createSession: (req: CreateSessionRequest): Promise<SessionInfo> => call('POST', '/api/sessions', req),
  updateSession: (id: string, patch: { name?: string; color?: string; background?: TerminalBackground | null; font?: TerminalFont | null }): Promise<SessionInfo> =>
    call('PATCH', `/api/sessions/${encodeURIComponent(id)}`, patch),
  ackSession: (id: string): Promise<SessionInfo> => call('POST', `/api/sessions/${encodeURIComponent(id)}/ack`),
  deleteSession: (id: string): Promise<void> => call('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  saveProfiles: (profiles: Profile[]): Promise<Profile[]> => call('PUT', '/api/profiles', profiles),
  conversations: (): Promise<ConversationItem[]> => call('GET', '/api/conversations'),
  /** Reopens a closed session; `storyId` puts it in that area (null: in none), omitted: where it was. */
  reopenClosed: (id: string, storyId?: string | null): Promise<SessionInfo> =>
    call('POST', `/api/closed/${encodeURIComponent(id)}/reopen`, storyId === undefined ? {} : { storyId }),
  forgetClosed: (id: string): Promise<void> => call('DELETE', `/api/closed/${encodeURIComponent(id)}`),
  folders: (path?: string): Promise<FolderListing> => call('GET', path ? `/api/folders?path=${encodeURIComponent(path)}` : '/api/folders'),
  moveSession: (id: string, storyId: string | null): Promise<SessionInfo> =>
    call('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { storyId }),
  createStory: (input: StoryFields): Promise<Story> => call('POST', '/api/stories', input),
  updateStory: (id: string, input: StoryFields): Promise<Story> => call('PATCH', `/api/stories/${encodeURIComponent(id)}`, input),
  deleteStory: (id: string): Promise<void> => call('DELETE', `/api/stories/${encodeURIComponent(id)}`),
  createSchedule: (fields: ScheduleFields): Promise<Schedule> => call('POST', '/api/schedules', fields),
  updateSchedule: (id: string, fields: ScheduleFields): Promise<Schedule> => call('PATCH', `/api/schedules/${encodeURIComponent(id)}`, fields),
  deleteSchedule: (id: string): Promise<void> => call('DELETE', `/api/schedules/${encodeURIComponent(id)}`),
  runSchedule: (id: string): Promise<ScheduleRun> => call('POST', `/api/schedules/${encodeURIComponent(id)}/run`),
};
