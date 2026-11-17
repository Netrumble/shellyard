import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { Conversation, CreateSessionRequest, HookName, Profile, SessionInfo, SessionKind, Story, TerminalBackground, TerminalFont } from '../shared/types.js';
import { normalizeBackground } from './backgrounds.js';
import { normalizeFont } from './fonts.js';
import { findConversation } from './conversations.js';
import type { RestoreEntry } from './restore.js';
import { cleanupClaudeLaunch, prepareClaudeLaunch, withoutClaudeSessionMarkers } from './claude-launch.js';
import type { Config } from './config.js';
import { isTerminalReport } from './input.js';
import { PtySession, type PtyFactory } from './pty-session.js';
import { detectProfiles, resolveExecutable, toLaunch } from './shells.js';
import { initialState, reduce, type StatusEvent } from './state.js';

export interface ManagerDeps {
  ptyFactory: PtyFactory;
  now: () => number;
  config: () => Config;
  port: number;
  hookToken: string;
  hookScriptPath: string;
  statusScriptPath: string;
  /** Profiles offered without configuration. Defaults to what is installed on this machine. */
  builtins?: () => Profile[];
  /** The current stories, to validate a session's story and borrow its folder and colour. */
  stories?: () => Story[];
  /** Looks up a saved Claude Code conversation. Defaults to reading Claude Code's own files. */
  findConversation?: (id: string) => Conversation | null;
}

const CLAUDE_PROFILE = 'builtin-claude';
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_COLOR = '#888888';
/** Output arriving this soon after the user typed is taken to be the echo of that typing. */
const ECHO_WINDOW_MS = 500;
/**
 * Output arriving this soon after a resize is taken to be the program repainting. Showing a
 * waiting session resizes its terminal, so without this the repaint would read as "it is
 * working again" and the session would drop out of sight just as it was put on screen.
 */
const REPAINT_WINDOW_MS = 1500;

interface Entry {
  info: SessionInfo;
  pty: PtySession | null;
  lastOutputAt: number;
  lastInputAt: number;
  lastResizeAt: number;
  profileId: string | null;
  /** The model asked for at launch; info.model may later show what Claude Code reports. */
  launchModel: string | null;
  /** For a Claude session, the conversation it holds, as far as is known. */
  conversationId: string | null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly changeCbs: Array<(sessions: SessionInfo[]) => void> = [];
  private readonly outputCbs: Array<(id: string, data: string) => void> = [];
  private readonly closedCbs: Array<(entry: RestoreEntry, sessionId: string) => void> = [];

  constructor(private readonly deps: ManagerDeps) {}

  list(): SessionInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(id: string): SessionInfo | null {
    const e = this.entries.get(id);
    return e ? { ...e.info } : null;
  }

  /**
   * All profiles a session can be created from: the user's own first, then the built-in
   * ones. A built-in profile the user has changed keeps its place and shows the saved version.
   */
  profiles(): Profile[] {
    const saved = this.deps.config().profiles;
    const builtins = (this.deps.builtins ?? detectProfiles)();
    const builtinIds = new Set(builtins.map((p) => p.id));
    const own = saved.filter((p) => !builtinIds.has(p.id));
    return [...own, ...builtins.map((b) => saved.find((p) => p.id === b.id) ?? b)];
  }

  /**
   * Creates a session. A bad folder, an unknown command or a failed start does not throw:
   * the session is created already exited, carrying the reason, so the UI can show it.
   */
  create(req: CreateSessionRequest): SessionInfo {
    const now = this.deps.now();
    const id = randomUUID();
    let profile: Profile | undefined;
    let problem: string | null = null;

    // Continuing a saved conversation: it decides the folder, and Claude Code runs it.
    let conversation: Conversation | null = null;
    if (req.resume !== undefined) {
      conversation = (this.deps.findConversation ?? findConversation)(req.resume);
      if (!conversation) problem = 'Conversation not found. It may have been deleted, or nothing was ever asked in it.';
      else {
        const openIn = this.openConversations().get(conversation.id);
        const holder = openIn ? this.entries.get(openIn) : undefined;
        if (holder) problem = `This conversation is already open here, in "${holder.info.name}".`;
      }
    }

    const profileId = req.profileId ?? (req.resume !== undefined ? CLAUDE_PROFILE : undefined);
    if (profileId) {
      profile = this.profiles().find((p) => p.id === profileId);
      // A resumed session may name its command itself (when it is brought back after a restart).
      if (!profile && !(req.resume !== undefined && req.command)) problem ??= `Profile not found: ${profileId}`;
    }

    const kind: SessionKind = req.resume !== undefined ? 'claude' : (req.kind ?? profile?.kind ?? 'shell');
    const command = (req.command ?? profile?.command ?? '').trim();
    const args = req.args ?? profile?.args ?? [];
    const story = req.storyId ? this.story(req.storyId) : undefined;
    // A session started inside a story works in the story's folder unless told otherwise.
    const cwd = conversation?.cwd || (req.cwd ?? '').trim() || story?.cwd || profile?.cwd || homedir();
    const model = kind === 'claude' ? (req.model !== undefined ? req.model : (profile?.model ?? null)) || null : null;
    const name = (req.name ?? '').trim() || conversation?.title.slice(0, 48) || profile?.name || basename(command) || 'session';
    const color = (req.color ?? '').trim() || story?.color || profile?.color || DEFAULT_COLOR;

    const info: SessionInfo = {
      id,
      kind,
      storyId: story?.id ?? null,
      name,
      color,
      cwd,
      command,
      args,
      model,
      ...initialState(kind),
      statusSince: now,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      exitCode: null,
      error: null,
      resumed: false,
      // The request decides if it says anything (null included); otherwise the profile does.
      background: req.background !== undefined ? normalizeBackground(req.background) : normalizeBackground(profile?.background),
      font: req.font !== undefined ? normalizeFont(req.font) : normalizeFont(profile?.font),
    };
    const entry: Entry = {
      info,
      pty: null,
      lastOutputAt: now,
      lastInputAt: 0,
      lastResizeAt: 0,
      profileId: profile?.id ?? null,
      launchModel: model,
      // A new Claude session is started under its own id, which is then its conversation's id.
      conversationId: kind === 'claude' ? (conversation?.id ?? id) : null,
    };
    this.entries.set(id, entry);

    if (!problem && !command) problem = 'No command was given.';
    if (!problem && !isDirectory(cwd)) problem = `Folder does not exist: ${cwd}`;
    const resolved = problem ? null : resolveExecutable(command);
    if (!problem && !resolved) problem = `Command not found: ${command}`;

    if (!problem && resolved) {
      try {
        let launchArgs = args;
        const env: Record<string, string> = { ...withoutClaudeSessionMarkers(process.env), ...(profile?.env ?? {}) };
        if (kind === 'claude') {
          const launch = prepareClaudeLaunch({
            sessionId: id,
            port: this.deps.port,
            hookToken: this.deps.hookToken,
            model,
            hookScriptPath: this.deps.hookScriptPath,
            statusScriptPath: this.deps.statusScriptPath,
            extraArgs: args,
            resumeId: conversation?.id ?? null,
          });
          launchArgs = launch.args;
          Object.assign(env, launch.env);
        }
        entry.pty = new PtySession(this.deps.ptyFactory, toLaunch(resolved, launchArgs), {
          cwd,
          env,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        });
        this.wire(entry);
        info.resumed = conversation !== null;
      } catch (e) {
        problem = `Could not start ${command}: ${(e as Error).message}`;
      }
    }

    if (problem) {
      info.status = 'exited';
      info.reason = null;
      info.error = problem;
      cleanupClaudeLaunch(id);
    }
    this.emitChange();
    return { ...info };
  }

  private wire(entry: Entry): void {
    const { pty, info } = entry;
    if (!pty) return;
    pty.onOutput((data) => {
      if (!this.entries.has(info.id)) return;
      const now = this.deps.now();
      for (const cb of this.outputCbs) cb(info.id, data);
      const echo = now - entry.lastInputAt <= ECHO_WINDOW_MS;
      const repaint = now - entry.lastResizeAt <= REPAINT_WINDOW_MS;
      // Only output the program produced on its own shows that it is busy.
      if (echo || repaint) return;
      entry.lastOutputAt = now;
      this.dispatch(entry, { type: 'output' });
    });
    pty.onExit((code) => {
      info.exitCode = code;
      cleanupClaudeLaunch(info.id);
      // Removed by the user (reported then) or by the server stopping (not a closing at all).
      if (!this.entries.has(info.id)) return;
      this.emitClosed(entry);
      this.dispatch(entry, { type: 'exit' }, true);
    });
  }

  /** Applies an event; announces a change only if the status actually moved (or when forced). */
  private dispatch(entry: Entry, event: StatusEvent, force = false): void {
    const { info } = entry;
    const next = reduce(info.kind, { status: info.status, reason: info.reason }, event);
    const changed = next.status !== info.status || next.reason !== info.reason;
    if (changed) {
      const now = this.deps.now();
      // Silence is measured from the later of "last output" and "work started", so a
      // session that sat quiet for an hour is not flagged the instant it starts working.
      if (next.status === 'working') entry.lastOutputAt = Math.max(entry.lastOutputAt, now);
      info.status = next.status;
      info.reason = next.reason;
      info.statusSince = now;
    }
    if (changed || force) this.emitChange();
  }

  private story(id: string): Story | undefined {
    return this.deps.stories?.().find((s) => s.id === id);
  }

  /** Ungroups the sessions of a story that is going away. They keep running. */
  clearStory(storyId: string): void {
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.info.storyId === storyId) {
        e.info.storyId = null;
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  update(id: string, patch: { name?: string; color?: string; storyId?: string | null; background?: TerminalBackground | null; font?: TerminalFont | null }): SessionInfo | null {
    const e = this.entries.get(id);
    if (!e) return null;
    // undefined leaves the background alone; null, or one that is not valid, clears it.
    if (patch.background !== undefined) e.info.background = normalizeBackground(patch.background);
    if (patch.font !== undefined) e.info.font = normalizeFont(patch.font);
    // undefined leaves the story as it is; null, or a story that does not exist, ungroups.
    if (patch.storyId !== undefined) e.info.storyId = patch.storyId ? (this.story(patch.storyId)?.id ?? null) : null;
    const name = typeof patch.name === 'string' ? patch.name.trim() : '';
    const color = typeof patch.color === 'string' ? patch.color.trim() : '';
    if (name) e.info.name = name;
    if (color) e.info.color = color;
    this.emitChange();
    return { ...e.info };
  }

  /** Conversation id → the session holding it, for the Claude sessions still running. */
  openConversations(): Map<string, string> {
    const open = new Map<string, string>();
    for (const e of this.entries.values()) {
      if (e.conversationId && e.info.status !== 'exited') open.set(e.conversationId, e.info.id);
    }
    return open;
  }

  /** The conversation a session holds, as far as is known. */
  conversationOf(id: string): string | null {
    return this.entries.get(id)?.conversationId ?? null;
  }

  /** The conversation Claude Code says the session is holding (it changes with /clear or /resume). */
  setConversation(id: string, conversationId: string): void {
    const e = this.entries.get(id);
    if (!e || e.info.kind !== 'claude' || !CONVERSATION_ID.test(conversationId)) return;
    if (e.conversationId === conversationId) return;
    e.conversationId = conversationId;
    this.emitChange();
  }

  /** What is needed to start a session like this one again. */
  private describe(e: Entry): RestoreEntry {
    return {
      kind: e.info.kind,
      profileId: e.profileId,
      name: e.info.name,
      color: e.info.color,
      cwd: e.info.cwd,
      command: e.info.command,
      args: e.info.args,
      storyId: e.info.storyId,
      model: e.launchModel,
      conversationId: e.conversationId,
      background: e.info.background,
      font: e.info.font,
    };
  }

  /** What would be needed to start the running sessions again after a restart. */
  restorable(): RestoreEntry[] {
    return [...this.entries.values()].filter((e) => e.info.status !== 'exited').map((e) => this.describe(e));
  }

  private emitClosed(e: Entry): void {
    const entry = this.describe(e);
    for (const cb of this.closedCbs) cb(entry, e.info.id);
  }

  /**
   * Called when a session that had started comes to an end: its process finished, or the
   * user closed it while it ran. Not called for the sessions the server ends by stopping.
   */
  onClosed(cb: (entry: RestoreEntry, sessionId: string) => void): void {
    this.closedCbs.push(cb);
  }

  /** The model Claude Code says the session is using now (it can change with /model). */
  setModel(id: string, model: string): void {
    const e = this.entries.get(id);
    if (!e || !model || e.info.model === model) return;
    e.info.model = model;
    this.emitChange();
  }

  ack(id: string): SessionInfo | null {
    const e = this.entries.get(id);
    if (!e) return null;
    this.dispatch(e, { type: 'ack' });
    return { ...e.info };
  }

  hook(id: string, name: HookName, idleReminder: boolean): boolean {
    const e = this.entries.get(id);
    if (!e || e.info.status === 'exited') return false;
    this.dispatch(e, { type: 'hook', name, idleReminder });
    return true;
  }

  input(id: string, data: string): void {
    const e = this.entries.get(id);
    if (!e || !e.pty || e.info.status === 'exited') return;
    e.pty.write(data);
    // Focus reports, cursor-position answers and the like pass through, but they are the
    // terminal talking, not the user responding.
    if (isTerminalReport(data)) return;
    e.lastInputAt = this.deps.now();
    this.dispatch(e, { type: 'input' });
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id);
    if (!e || !e.pty) return;
    e.pty.resize(cols, rows);
    if (e.pty.cols !== e.info.cols || e.pty.rows !== e.info.rows) {
      e.lastResizeAt = this.deps.now();
      e.info.cols = e.pty.cols;
      e.info.rows = e.pty.rows;
      this.emitChange();
    }
  }

  async snapshot(id: string): Promise<string | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    return e.pty ? e.pty.snapshot() : '';
  }

  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    // Closed while it was running; one that had already ended was reported when it ended.
    if (e.pty && e.info.status !== 'exited') this.emitClosed(e);
    this.entries.delete(id);
    e.pty?.kill();
    e.pty?.dispose();
    cleanupClaudeLaunch(id);
    this.emitChange();
    return true;
  }

  /** Flags working sessions whose terminal has gone quiet: they are probably waiting. */
  tick(): void {
    const now = this.deps.now();
    const silenceMs = this.deps.config().silenceMs;
    for (const e of this.entries.values()) {
      if (e.info.status === 'working' && now - e.lastOutputAt >= silenceMs) this.dispatch(e, { type: 'silence' });
    }
  }

  onChange(cb: (sessions: SessionInfo[]) => void): void {
    this.changeCbs.push(cb);
  }

  onOutput(cb: (id: string, data: string) => void): void {
    this.outputCbs.push(cb);
  }

  shutdown(): void {
    for (const [id, e] of [...this.entries]) {
      this.entries.delete(id);
      e.pty?.kill();
      e.pty?.dispose();
      cleanupClaudeLaunch(id);
    }
  }

  private emitChange(): void {
    const sessions = this.list();
    for (const cb of this.changeCbs) cb(sessions);
  }
}
