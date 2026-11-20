import { useSyncExternalStore } from 'react';
import type { ClosedSession, Meta, Schedule, SessionInfo, SoundLibrary, Story, UsageSummary } from '../shared/types.js';
import { api, configureApi } from './api.js';
import { loadEffects, loadSound, saveEffects, saveSound, type EffectsLevel } from './effects.js';
import { connect, type ConnectionState, type Socket } from './socket.js';
import { loadThemeChoice, resolveTheme, saveThemeChoice, systemPrefersLight, watchSystemTheme, type Theme, type ThemeChoice } from './theme.js';
import { loadToken, rememberToken, wsProtocols } from './token.js';

/** `storyFilter`: a story id, null for the ungrouped sessions, undefined for everything. */
export type View =
  | { kind: 'board' }
  | { kind: 'attention'; storyFilter?: string | null }
  | { kind: 'grid'; storyFilter?: string | null }
  | { kind: 'usage' }
  | { kind: 'conversations' }
  | { kind: 'schedules' }
  | { kind: 'single'; id: string };

interface State {
  sessions: SessionInfo[];
  stories: Story[];
  /** Sessions that ended or were closed, newest first. */
  closed: ClosedSession[];
  schedules: Schedule[];
  /** Null until the server has sent it. */
  usage: UsageSummary | null;
  /** Bytes printed in the last second per session; absent means quiet. */
  activity: Record<string, number>;
  /** False until the first list arrives, so an empty list is not shown as "nothing open". */
  loaded: boolean;
  view: View;
  connection: ConnectionState;
  meta: Meta;
  soundLibrary: SoundLibrary;
  /** How much the interface moves; a choice of this browser. */
  effects: EffectsLevel;
  sound: boolean;
  /** What the user chose, and the theme that choice comes to right now. */
  themeChoice: ThemeChoice;
  theme: Theme;
}

let state: State = {
  sessions: [],
  stories: [],
  closed: [],
  schedules: [],
  usage: null,
  activity: {},
  loaded: false,
  view: { kind: 'board' },
  connection: 'connecting',
  meta: { profiles: [], models: [], saved: [] },
  soundLibrary: { sounds: [], settings: { blocked: null, finished: null, maybeWaiting: null } },
  effects: 'reduced',
  sound: true,
  themeChoice: 'system',
  theme: 'dark',
};
const listeners = new Set<() => void>();
const sessionListeners: Array<(prev: SessionInfo[], next: SessionInfo[]) => void> = [];
let socket: Socket | null = null;
/** A token taken from the address, to be stored once the server has accepted it. */
let unconfirmedToken: string | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

export function getState(): State {
  return state;
}

export function getSocket(): Socket {
  if (!socket) throw new Error('The store has not been started');
  return socket;
}

function applyEffects(level: EffectsLevel): void {
  // The stylesheet switches animations on this attribute.
  if (typeof document !== 'undefined') document.documentElement.dataset.effects = level;
}

const themeListeners = new Set<(theme: Theme) => void>();

/** For what is drawn outside the stylesheet's reach (the terminals). Returns an unsubscribe. */
export function onThemeChange(cb: (theme: Theme) => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

function applyTheme(choice: ThemeChoice): void {
  const theme = resolveTheme(choice, systemPrefersLight());
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
  const changed = theme !== state.theme;
  set({ themeChoice: choice, theme });
  if (changed) for (const cb of [...themeListeners]) cb(theme);
}

export function setTheme(choice: ThemeChoice): void {
  saveThemeChoice(choice);
  applyTheme(choice);
}

export function setEffects(effects: EffectsLevel): void {
  saveEffects(effects);
  applyEffects(effects);
  set({ effects });
}

export function setSound(sound: boolean): void {
  saveSound(sound);
  set({ sound });
}

export function setView(view: View): void {
  set({ view });
}

export async function refreshMeta(): Promise<void> {
  try {
    const meta = await api.meta();
    if (unconfirmedToken) {
      rememberToken(unconfirmedToken);
      unconfirmedToken = null;
    }
    set({ meta });
  } catch {
    // The profile list is not essential; it is retried the next time the dialog opens.
  }
}

export async function refreshSounds(): Promise<void> {
  try {
    set({ soundLibrary: await api.sounds() });
  } catch {
    // The library is not essential; it is read again after the next change.
  }
}

/** Runs on every change of the session list, with the list before and after. */
export function onSessionsChange(cb: (prev: SessionInfo[], next: SessionInfo[]) => void): void {
  sessionListeners.push(cb);
}

/** A view filtered on a story that has been deleted falls back to showing everything. */
function withoutDeadFilter(view: View, stories: Story[]): View {
  if (view.kind !== 'attention' && view.kind !== 'grid') return view;
  if (typeof view.storyFilter !== 'string') return view;
  return stories.some((s) => s.id === view.storyFilter) ? view : { kind: view.kind };
}

export function startStore(): void {
  if (socket) return;
  const effects = loadEffects();
  applyEffects(effects);
  set({ effects, sound: loadSound() });
  applyTheme(loadThemeChoice());
  watchSystemTheme(() => {
    if (state.themeChoice === 'system') applyTheme('system');
  });
  const loaded = loadToken();
  if (!loaded) {
    // Opened by typing the address, or in a browser that never received the token.
    set({ connection: 'unauthorized' });
    return;
  }
  const { token } = loaded;
  if (loaded.fromAddress) unconfirmedToken = token;
  // A token left over from an earlier run of the server is refused: say how to get back in,
  // and stop knocking on a server that will never let this token in.
  configureApi({
    token,
    onUnauthorized: () => {
      set({ connection: 'unauthorized' });
      socket?.stop();
    },
  });
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = connect(`${scheme}://${location.host}/ws`, wsProtocols(token));
  socket.onSessions((sessions) => {
    const prev = state.sessions;
    const wasLoaded = state.loaded;
    // A session shown on its own that no longer exists sends the user back to the grid.
    const current = state.view;
    const view: View = current.kind === 'single' && !sessions.some((s) => s.id === current.id) ? { kind: 'grid' } : current;
    set({ sessions, loaded: true, view });
    if (wasLoaded) for (const cb of sessionListeners) cb(prev, sessions);
  });
  socket.onStories((stories) => set({ stories, view: withoutDeadFilter(state.view, stories) }));
  socket.onClosed((closed) => set({ closed }));
  socket.onSchedules((schedules) => set({ schedules }));
  socket.onUsage((usage) => set({ usage }));
  socket.onActivity((activity) => set({ activity }));
  socket.onState((connection) => {
    // Once the token is known to be refused, a failing socket must not hide that message.
    if (state.connection === 'unauthorized') return;
    set({ connection });
    if (connection === 'open') {
      void refreshMeta();
      void refreshSounds();
    }
  });
  // A handshake refused for a stale token looks like a server that is not running. An API
  // call tells them apart (401 → onUnauthorized above), so ask after every failed attempt:
  // a tab left open across a server restart must end up being told what to do.
  socket.onAttemptFailed(() => {
    if (state.connection !== 'unauthorized') void refreshMeta();
  });
  void refreshMeta();
  void refreshSounds();
}

export function useStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
