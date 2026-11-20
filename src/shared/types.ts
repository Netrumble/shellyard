export type SessionKind = 'claude' | 'shell';
export type Status = 'idle' | 'working' | 'attention' | 'running' | 'exited';
export type Reason = 'blocked' | 'finished' | 'maybe-waiting' | null;
export type HookName = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';

export const HOOK_NAMES: readonly HookName[] = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
];

/**
 * What is behind the text of a terminal: a colour, or an uploaded image (by the name ShellYard
 * stored it under) with a dark veil over it, 0 for none to nearly 1 for almost black.
 */
export interface TerminalBackground {
  color: string | null;
  image: string | null;
  veil: number;
}

/** The font of a terminal. A null part is left to the default (Cascadia Mono, 13). */
export interface TerminalFont {
  family: string | null;
  /** In pixels. */
  size: number | null;
}

/** A named group of sessions, typically one piece of work. An empty string means "not set". */
export interface Story {
  id: string;
  name: string;
  ticket: string;
  cwd: string;
  color: string;
}

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  storyId: string | null;
  name: string;
  color: string;
  cwd: string;
  command: string;
  args: string[];
  model: string | null;
  status: Status;
  reason: Reason;
  statusSince: number;
  cols: number;
  rows: number;
  exitCode: number | null;
  error: string | null;
  /** True when the session continues a Claude Code conversation that already existed. */
  resumed: boolean;
  /** Null: the terminal follows the theme. */
  background: TerminalBackground | null;
  /** The font and text size chosen for this terminal; null: the default. */
  font: TerminalFont | null;
  /** The git worktree the session works in; null outside a repository or before git answered. */
  git: SessionGit | null;
  /** For a Claude session, the folder Claude reports it is working in now. */
  liveCwd: string | null;
}

export interface SessionGit {
  worktree: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  worktreeCount: number;
}

/** A Claude Code conversation saved on disk, which can be continued in a new session. */
export interface Conversation {
  id: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

/** A session that ended or was closed, and can be opened again in its area. */
export interface ClosedSession {
  id: string;
  /** The session it came from. */
  sessionId: string;
  closedAt: number;
  kind: SessionKind;
  name: string;
  color: string;
  cwd: string;
  storyId: string | null;
  /** True if reopening continues a Claude Code conversation; false if it starts afresh. */
  resumes: boolean;
}

export interface ConversationItem extends Conversation {
  /** The session in which this conversation is open here, if it is. */
  openIn: string | null;
}

export interface Profile {
  id: string;
  name: string;
  kind: SessionKind;
  command: string;
  args: string[];
  cwd: string;
  color: string;
  env: Record<string, string>;
  model: string | null;
  /** The background its sessions start with; absent or null: the theme's. */
  background?: TerminalBackground | null;
  /** The font and text size its sessions start with; absent or null: the default. */
  font?: TerminalFont | null;
}

export interface CreateSessionRequest {
  profileId?: string;
  kind?: SessionKind;
  command?: string;
  args?: string[];
  name?: string;
  cwd?: string;
  color?: string;
  model?: string | null;
  storyId?: string | null;
  /** The id of a saved Claude Code conversation to continue. */
  resume?: string;
  /** Overrides the profile's background; null asks for the theme's. */
  background?: TerminalBackground | null;
  /** Overrides the profile's font; null asks for the default. */
  font?: TerminalFont | null;
}

export interface Meta {
  profiles: Profile[];
  models: string[];
  /** Ids of the profiles kept in the config file: the user's own, and changed built-ins. */
  saved: string[];
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: Array<{ name: string; path: string }>;
  roots: string[];
}

/** How much of a plan limit is used, and when it resets (milliseconds since the epoch). */
export interface LimitReading {
  usedPercentage: number;
  resetsAt: number;
}

export interface UsageLine {
  key: string;
  label: string;
  tokensIn: number;
  tokensOut: number;
  /** Claude Code's own estimate of what this would cost at API prices. */
  costUsd: number;
}

export interface UsagePeriod {
  costUsd: number;
  byModel: UsageLine[];
  byStory: UsageLine[];
}

export interface UsageSummary {
  limits: { fiveHour: LimitReading | null; sevenDay: LimitReading | null; readAt: number | null };
  /** Today, the last 7 days and the last 30 days, each including today. */
  today: UsagePeriod;
  week: UsagePeriod;
  month: UsagePeriod;
}

export type ClientMessage =
  | { t: 'attach'; id: string; cols: number; rows: number }
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number };

/** When a schedule runs. Times are the local time of the machine ShellYard runs on. */
export type ScheduleWhen =
  | { kind: 'once'; at: number }
  /** `time` is "HH:MM"; `days` are weekdays, 0 for Sunday to 6 for Saturday. */
  | { kind: 'weekly'; time: string; days: number[] }
  | { kind: 'interval'; minutes: number }
  /** Five fields: minute, hour, day of month, month, weekday. */
  | { kind: 'cron'; expr: string };

/**
 * How a scheduled session asks before acting. "default" passes nothing, so Claude Code uses
 * the mode it is set up with. The modes that never ask are deliberately not offered.
 */
export const SCHEDULE_PERMISSION_MODES = ['default', 'manual', 'acceptEdits', 'auto', 'plan'] as const;
export type SchedulePermissionMode = (typeof SCHEDULE_PERMISSION_MODES)[number];

/**
 * started: the session is open and the prompt is on its way; delivered: Claude Code took the
 * prompt; undelivered: the session is open but the prompt did not get in; failed: no session
 * could be started; skipped: the run did not happen.
 */
export type ScheduleOutcome = 'started' | 'delivered' | 'undelivered' | 'failed' | 'skipped';

export interface ScheduleRun {
  at: number;
  outcome: ScheduleOutcome;
  detail: string | null;
  sessionId: string | null;
  /** True for a run asked for by hand. */
  manual: boolean;
}

/** A prompt given to a new Claude Code session at set times. */
export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  profileId: string;
  /**
   * What the launcher ran when the schedule was last saved (a digest of its kind, command,
   * arguments and environment). A run whose launcher has changed since is refused: nobody is
   * at the screen to see that it now starts something else. Null: no such launcher then.
   */
  launcher: string | null;
  /** Null: the profile's own model. */
  model: string | null;
  /** Empty: the folder of the area, or else of the profile. */
  cwd: string;
  storyId: string | null;
  when: ScheduleWhen;
  enabled: boolean;
  /** Whether a run missed while ShellYard was not running is made up for at the next start. */
  catchUp: boolean;
  permissionMode: SchedulePermissionMode;
  createdAt: number;
  /** Null when it will not run again by itself. */
  nextRunAt: number | null;
  /** Newest first. */
  runs: ScheduleRun[];
}

export type ServerMessage =
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'schedules'; schedules: Schedule[] }
  | { t: 'stories'; stories: Story[] }
  | { t: 'closed'; closed: ClosedSession[] }
  | { t: 'usage'; usage: UsageSummary }
  /** Bytes printed in the last second, per session; sessions printing nothing are absent. */
  | { t: 'activity'; rates: Record<string, number> }
  | { t: 'snapshot'; id: string; data: string }
  | { t: 'output'; id: string; data: string };

export interface Worktree {
  path: string;
  /** Null when the worktree is detached. */
  branch: string | null;
  /** The checked-out commit, shortened to 7 characters. */
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  /** The entry of a bare repository: no files checked out, nothing to work in. */
  bare: boolean;
}

export interface WorktreeListing {
  /** The worktree the asked folder belongs to. */
  current: string;
  worktrees: Worktree[];
}
