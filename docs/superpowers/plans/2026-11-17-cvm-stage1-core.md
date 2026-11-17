# Console View Manager — Stage 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An npm-installable `cvm` command that hosts Claude Code and shell terminals in a local server and shows them in a browser, with per-session status and a "Needs attention" panel where the user answers in place.

**Architecture:** A Node server bound to 127.0.0.1 owns node-pty processes, mirrors each into a headless xterm for screen restore, and exposes REST + one WebSocket per browser tab. Claude Code sessions report their state through hooks passed with `--settings`; a pure reducer plus an output-silence timer turns those events into a status. A React + xterm.js client renders the sidebar, terminals grid and attention panel.

**Tech Stack:** TypeScript, Node >= 22, `node:http`, `ws`, `node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, `open`; React, Vite, `@xterm/xterm`, `@xterm/addon-fit`; Vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-console-view-manager-design.md`

**Stages.** The spec is delivered in three plans. This is stage 1. Not in this plan: stories (stage 2); the Usage view, gauges and the "Visual character" effects (stage 3). Stage 1 uses a plain dark theme whose colours are CSS variables, so stage 3 restyles without rewrites. Model selection is in this stage because it is one launch flag.

## Global Constraints

- Node.js >= 22 (`"engines": {"node": ">=22"}`).
- Package name `console-view-manager`, binary `cvm`, one npm package; the web UI is built before publishing and shipped in `dist/web`.
- Works on Windows and Linux. Never use a POSIX-only or Windows-only API without a branch for the other.
- The server binds to `127.0.0.1` only.
- Never write to the user's global or project Claude Code settings. Per-session settings go to CVM's own folder.
- User data folder: `~/.console-view-manager/` (`config.json`, `server.json`, `cvm.log`, `run/`).
- Default port 7717, else the next free one. Scrollback 5,000 lines. Silence threshold 5,000 ms (configurable as `silenceMs` in `config.json`).
- A missed "needs attention" is the worst failure; when in doubt, show a session as waiting.
- Everything written in the repository is in English.
- Do not `git init`, commit or push unless the user has authorised it for this work. If not authorised, skip every "Commit" step.
- Install dependencies at their current latest versions; do not pin versions from memory.

## Review Focus

1. **A session whose folder or command does not exist** (deleted folder, path with spaces or non-ASCII characters, mistyped command): the session appears as `exited` with the error text; the server keeps running. Test in Task 6.
2. **A burst of output far larger than the scrollback** (for example printing a 20 MB file): output reaches clients in order, the mirror stays capped at 5,000 lines, other sessions stay responsive. Test in Task 4.
3. **Hook posts that do not match a live session or are not valid JSON** (a Claude process outliving its session, a truncated body): answered 404 / 400, no state change, no crash. Test in Task 8.
4. **Two browser tabs on the same server**: both receive output; closing one does not detach or kill anything for the other. Test in Task 9.
5. **A stale `server.json`** (process gone, or the pid now belongs to another program): `cvm` starts a fresh server instead of opening a dead address. Test in Task 10.

## File Structure

```
package.json  tsconfig.json  tsconfig.server.json  vite.config.ts  vitest.config.ts
src/shared/types.ts            shared types: Session, Status, Profile, API and WS messages
src/server/state.ts            pure status reducer
src/server/config.ts           data-folder paths, config.json and server.json read/write
src/server/shells.ts           executable resolution, built-in profile detection
src/server/pty-session.ts      one node-pty process + headless mirror
src/server/claude-launch.ts    command line, env and settings file for a Claude session
src/server/session-manager.ts  registry, reducer wiring, silence timer, change events
src/server/auth.ts             tokens, cookie, Host/Origin checks
src/server/http.ts             REST routes and static files
src/server/ws.ts               WebSocket protocol
src/server/index.ts            startServer(), server entry when run directly
src/hook/hook.ts               hook forwarder run by Claude Code
src/cli/cvm.ts                 the `cvm` command
src/web/                       index.html, main.tsx, App.tsx, theme.css, api.ts, socket.ts,
                               store.ts, notify.ts, components/{Sidebar,TerminalView,
                               TerminalsGrid,AttentionPanel,NewSessionDialog}.tsx
tests/server/*.test.ts  tests/hook/*.test.ts  tests/web/*.test.ts
```

Build output: `dist/server`, `dist/hook`, `dist/cli` (tsc) and `dist/web` (vite).

---

### Task 0: Verify the three risks (throwaway spike)

Nothing from this task ships. Work in `spikes/` (git-ignored). Its only deliverable is the "Findings" section appended at the end of this plan, which later tasks read.

- [ ] **Step 1: node-pty on Windows.** In `spikes/pty`, `npm init -y && npm install node-pty`. Record whether it installed without a compiler. Spawn `pwsh` and print its output; then spawn `claude --version` both directly and through `cmd.exe /d /s /c`. Record which form works.
- [ ] **Step 2: node-pty on Linux.** If WSL or Docker is available, repeat the install in a clean `node:22` environment with no build tools. If it needs a compiler, repeat with `@lydell/node-pty` and record the result. If neither WSL nor Docker is available, record "Linux unverified" — Task 14's packaging gate then stays open and must be reported as such.
- [ ] **Step 3: hooks through `--settings`.** Write a settings file registering a command hook for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` that appends its stdin to a log file. Run `claude --settings <file> --session-id <uuid>` in a scratch folder and trigger: a prompt, a permission request (approve one, deny one), a finished turn, an Esc interrupt. Record: (a) whether the user's own hooks still fire, (b) the full `Notification` payload and which field distinguishes a permission request from an idle reminder, (c) which events fire after a denial and after Esc.
- [ ] **Step 4: output continuity.** While Claude runs a tool that takes over 10 seconds (`Start-Sleep 15`), measure the longest gap between pty output chunks. Record it. If gaps exceed 3 seconds, set the default `silenceMs` to twice the longest gap and note it under Findings.
- [ ] **Step 5: write Findings** at the end of this plan: one line per item above, plus the chosen pty package name and the chosen way to launch `claude` on Windows.

---

### Task 1: Scaffold and status reducer

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `vitest.config.ts`, `.gitignore`, `src/shared/types.ts`, `src/server/state.ts`
- Test: `tests/server/state.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):

```ts
export type SessionKind = 'claude' | 'shell';
export type Status = 'idle' | 'working' | 'attention' | 'running' | 'exited';
export type Reason = 'blocked' | 'finished' | 'maybe-waiting' | null;
export type HookName = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
export interface SessionInfo {
  id: string; kind: SessionKind; name: string; color: string; cwd: string;
  command: string; args: string[]; model: string | null;
  status: Status; reason: Reason; statusSince: number;
  cols: number; rows: number; exitCode: number | null; error: string | null;
}
export interface Profile {
  id: string; name: string; kind: SessionKind; command: string; args: string[];
  cwd: string; color: string; env: Record<string, string>; model: string | null;
}
export interface CreateSessionRequest {
  profileId?: string; kind?: SessionKind; command?: string; args?: string[];
  name?: string; cwd?: string; color?: string; model?: string | null;
}
export type ClientMessage =
  | { t: 'attach'; id: string; cols: number; rows: number }
  | { t: 'detach'; id: string }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number };
export type ServerMessage =
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'snapshot'; id: string; data: string }
  | { t: 'output'; id: string; data: string };
```

- Produces (`src/server/state.ts`):

```ts
export interface StatusState { status: Status; reason: Reason }
export type StatusEvent =
  | { type: 'hook'; name: HookName; idleReminder?: boolean }
  | { type: 'input' } | { type: 'output' } | { type: 'silence' }
  | { type: 'ack' } | { type: 'exit' };
export function initialState(kind: SessionKind): StatusState; // claude: idle, shell: running
export function reduce(kind: SessionKind, s: StatusState, e: StatusEvent): StatusState;
```

Transition table (anything not listed returns the state unchanged; `exited` never changes; a `shell` session reacts only to `exit`):

| Event | From | To |
|---|---|---|
| hook `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | any | `working`, null |
| hook `Notification`, `idleReminder` false | any | `attention`, `blocked` |
| hook `Notification`, `idleReminder` true | `working` | `attention`, `blocked` |
| hook `Stop` | any | `attention`, `finished` |
| `input` | `attention`/`blocked` | `working`, null |
| `output` | `attention`/`maybe-waiting` | `working`, null |
| `silence` | `working` | `attention`, `maybe-waiting` |
| `ack` | `attention`/`finished` | `idle`, null |
| `exit` | any | `exited`, null |

- [ ] **Step 1: Scaffold.** `package.json` with `"type": "module"`, `"bin": {"cvm": "dist/cli/cvm.js"}`, `"files": ["dist"]`, `"engines": {"node": ">=22"}`, scripts `build` (`tsc -p tsconfig.server.json && vite build`), `test` (`vitest run`), `dev:server`, `dev:web`. Install the dependencies named in Tech Stack (pty package per Findings). `.gitignore`: `node_modules`, `dist`, `spikes`.
- [ ] **Step 2: Write the failing tests** in `tests/server/state.test.ts`: one `it.each` row per line of the transition table, plus these named cases:

```ts
it('typing in a finished session does not hide it', () => {
  expect(reduce('claude', { status: 'attention', reason: 'finished' }, { type: 'input' }))
    .toEqual({ status: 'attention', reason: 'finished' });
});
it('an idle reminder does not resurface an acknowledged session', () => {
  expect(reduce('claude', { status: 'idle', reason: null },
    { type: 'hook', name: 'Notification', idleReminder: true }))
    .toEqual({ status: 'idle', reason: null });
});
it('exited is terminal', () => {
  expect(reduce('claude', { status: 'exited', reason: null }, { type: 'hook', name: 'Stop' }))
    .toEqual({ status: 'exited', reason: null });
});
it('a shell ignores everything but exit', () => {
  expect(reduce('shell', { status: 'running', reason: null }, { type: 'silence' }))
    .toEqual({ status: 'running', reason: null });
});
```

- [ ] **Step 3: Run** `npx vitest run tests/server/state.test.ts` — Expected: FAIL, `reduce` not found.
- [ ] **Step 4: Implement** `initialState` and `reduce` from the table.
- [ ] **Step 5: Run** the same command — Expected: PASS.
- [ ] **Step 6: Commit** `feat: scaffold and status reducer`.

---

### Task 2: Config and data folder

**Files:** Create `src/server/config.ts`; Test `tests/server/config.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Config { profiles: Profile[]; models: string[]; silenceMs: number }
export interface ServerState { pid: number; port: number; token: string; hookToken: string; startedAt: number }
export function dataDir(): string;                 // CVM_HOME env var, else ~/.console-view-manager
export function loadConfig(): { config: Config; warning: string | null };
export function saveConfig(c: Config): void;
export function readServerState(): ServerState | null;
export function writeServerState(s: ServerState): void;   // file mode 0o600
export function clearServerState(): void;
```

Defaults: `profiles: []`, `models: ['opus', 'sonnet', 'haiku']`, `silenceMs: 5000`. `CVM_HOME` exists so tests never touch the real folder.

- [ ] **Step 1: Write the failing tests** (each sets `CVM_HOME` to a fresh temp dir): missing file returns defaults and `warning: null`; a saved config round-trips; a file containing `{not json` returns defaults, a non-null warning mentioning `config.json.bad`, and the bad content now sits in `config.json.bad`; a config missing `silenceMs` gets `5000`; `readServerState()` is `null` when absent and round-trips after `writeServerState`.
- [ ] **Step 2: Run** `npx vitest run tests/server/config.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: config and data folder`.

---

### Task 3: Executable resolution and built-in profiles

**Files:** Create `src/server/shells.ts`; Test `tests/server/shells.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Launch { file: string; args: string[] }
export function resolveExecutable(name: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null;
export function toLaunch(resolvedPath: string, args: string[], platform?: NodeJS.Platform): Launch;
export function detectProfiles(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Profile[];
```

`resolveExecutable` searches `PATH`, trying each `PATHEXT` extension on Windows; an absolute path is returned as-is if it exists. `toLaunch` wraps a `.cmd`/`.bat` on Windows as `cmd.exe /d /s /c <path> <args>` and otherwise returns the path and args unchanged (adjust to the form Task 0 found working). `detectProfiles` returns, for those that resolve: Windows — Claude Code (`claude`), PowerShell 7 (`pwsh`), Windows PowerShell (`powershell`), Command Prompt (`cmd`), Git Bash (`C:\Program Files\Git\bin\bash.exe`); Linux — Claude Code, `$SHELL`, `bash`. Profile ids are stable strings (`builtin-claude`, `builtin-pwsh`, …), `cwd` is the user's home.

- [ ] **Step 1: Write the failing tests** using a temp dir with fake executables as `PATH`: resolves `tool` to `tool.cmd` on `win32` with `PATHEXT=.EXE;.CMD`; returns `null` when absent; `toLaunch('C:\\x\\claude.cmd', ['--v'], 'win32')` is `{ file: 'cmd.exe', args: ['/d','/s','/c','C:\\x\\claude.cmd','--v'] }`; `toLaunch('/usr/bin/claude', ['--v'], 'linux')` is unchanged; `detectProfiles` on a `PATH` holding only `pwsh` returns exactly one profile with id `builtin-pwsh`; on `linux` with `SHELL=/bin/zsh` existing, includes a profile whose command is `/bin/zsh`.
- [ ] **Step 2: Run** `npx vitest run tests/server/shells.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: executable resolution and built-in profiles`.

---

### Task 4: PtySession — process plus screen mirror

**Files:** Create `src/server/pty-session.ts`; Test `tests/server/pty-session.test.ts`

**Interfaces:**
- Consumes: `Launch` (Task 3).
- Produces:

```ts
export interface PtyLike {
  onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void; resize(cols: number, rows: number): void; kill(): void;
}
export type PtyFactory = (launch: Launch, opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => PtyLike;
export const realPtyFactory: PtyFactory;          // node-pty, name 'xterm-256color'
export class PtySession {
  constructor(factory: PtyFactory, launch: Launch, opts: { cwd: string; env: Record<string, string>; cols: number; rows: number });
  readonly cols: number; readonly rows: number;
  onOutput(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;       // ignores cols < 2 or rows < 2
  snapshot(): Promise<string>;                    // serialized screen + scrollback, after pending writes flush
  kill(): void;
}
```

The mirror is a `@xterm/headless` `Terminal` with `scrollback: 5000` and the serialize addon; every output chunk goes to subscribers first, then to the mirror. The constructor throws if the factory throws (spawn failure); the caller handles it.

- [ ] **Step 1: Write the failing tests** with a fake `PtyFactory`: output chunks reach `onOutput` subscribers in order; `snapshot()` after the fake emits `'hello\r\nworld'` contains both words; after 10,000 emitted lines `snapshot()` holds at most 5,000 + rows lines and still contains the last line (Review Focus 2); `resize(0, 0)` does not call the pty's `resize`; `resize(100, 30)` does and updates `cols`/`rows`; `write` is passed through; `onExit` fires with the code. One test with `realPtyFactory`: launch `process.execPath` with `['-e', "process.stdin.on('data',d=>process.stdout.write('got:'+d))"]`, write `'ping\r'`, expect output containing `got:ping` within 5 s, then `kill()`.
- [ ] **Step 2: Run** `npx vitest run tests/server/pty-session.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: pty session with screen mirror`.

---

### Task 5: Claude launch and hook forwarder

**Files:** Create `src/server/claude-launch.ts`, `src/hook/hook.ts`; Test `tests/server/claude-launch.test.ts`, `tests/hook/hook.test.ts`

**Interfaces:**
- Consumes: `dataDir()` (Task 2).
- Produces:

```ts
export interface ClaudeLaunchInput { sessionId: string; port: number; hookToken: string; model: string | null; hookScriptPath: string; extraArgs: string[] }
export interface ClaudeLaunchOutput { args: string[]; env: Record<string, string>; settingsPath: string }
export function prepareClaudeLaunch(i: ClaudeLaunchInput): ClaudeLaunchOutput;  // writes the settings file
export function cleanupClaudeLaunch(sessionId: string): void;                   // deletes it, never throws
export function parseHookBody(body: unknown): { name: HookName; idleReminder: boolean } | null;
```

- Settings file: `<dataDir>/run/<sessionId>.settings.json`, containing only a `hooks` object with one command hook per `HookName`, command `node "<hookScriptPath>"`.
- `args`: `['--settings', settingsPath, '--session-id', sessionId, ...(model ? ['--model', model] : []), ...extraArgs]`.
- `env`: `CVM_SESSION_ID`, `CVM_PORT`, `CVM_HOOK_TOKEN`.
- `parseHookBody` reads `hook_event_name`; returns `null` for an unknown name or a non-object. `idleReminder` is true only for a `Notification` that Task 0's Findings identify as an idle reminder; false otherwise.
- `hook.ts`: read stdin to the end, POST it to `http://127.0.0.1:$CVM_PORT/api/hooks/$CVM_SESSION_ID` with header `x-cvm-hook-token`, timeout 2 s. Print nothing. Always exit 0, including when the env vars are missing, the server is down, or stdin is not JSON.

- [ ] **Step 1: Write the failing tests.** `claude-launch`: args for `model: null` contain no `--model`; for `model: 'opus'` contain `'--model','opus'` after `--session-id`; the settings file exists, parses, has exactly the five hook names and no other top-level key; `cleanupClaudeLaunch` removes it and is silent when called twice; `parseHookBody({hook_event_name:'Stop'})` gives `{name:'Stop', idleReminder:false}`; `parseHookBody({hook_event_name:'Nope'})` and `parseHookBody('x')` give `null`. `hook`: run the built script as a child process with stdin `{"hook_event_name":"Stop"}` against a local test HTTP server and assert the body, path and token header arrived; run it with `CVM_PORT` pointing at a closed port and assert exit code 0, empty stdout and stderr, finished in under 3 s; run it with no env vars and assert exit 0.
- [ ] **Step 2: Run** `npx vitest run tests/server/claude-launch.test.ts tests/hook/hook.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: claude launch settings and hook forwarder`.

---

### Task 6: SessionManager

**Files:** Create `src/server/session-manager.ts`; Test `tests/server/session-manager.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState` (Task 1); `Config` (Task 2); `resolveExecutable`, `toLaunch` (Task 3); `PtySession`, `PtyFactory` (Task 4); `prepareClaudeLaunch`, `cleanupClaudeLaunch` (Task 5).
- Produces:

```ts
export interface ManagerDeps { ptyFactory: PtyFactory; now: () => number; config: () => Config; port: number; hookToken: string; hookScriptPath: string }
export class SessionManager {
  constructor(deps: ManagerDeps);
  list(): SessionInfo[];
  get(id: string): SessionInfo | null;
  create(req: CreateSessionRequest): SessionInfo;          // never throws for a bad command or folder
  update(id: string, patch: { name?: string; color?: string }): SessionInfo | null;
  ack(id: string): SessionInfo | null;
  hook(id: string, name: HookName, idleReminder: boolean): boolean;   // false if unknown or exited
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  snapshot(id: string): Promise<string | null>;
  remove(id: string): boolean;                             // kills if running, then forgets
  tick(): void;                                            // silence check; index.ts calls it every 1000 ms
  onChange(cb: (sessions: SessionInfo[]) => void): void;   // any status or metadata change
  onOutput(cb: (id: string, data: string) => void): void;
  shutdown(): void;                                        // kill all, clean up settings files
}
```

Rules: `create` merges the profile (if `profileId`) with the request's own fields, request wins; default `name` is the profile or command name, default `color` `#888888`, default size 120x30. Session `id` is `crypto.randomUUID()`. For `kind: 'claude'` it calls `prepareClaudeLaunch`. If the folder does not exist, the command does not resolve, or the factory throws, the session is created with `status: 'exited'`, `exitCode: null` and `error` set to a one-line message. `statusSince` updates only when status or reason changes. `input` writes to the pty and dispatches the `input` event; it also stamps `lastInputAt`. Pty output stamps `lastOutputAt`, and dispatches the `output` event only when `now - lastInputAt > 500` (so echo of the user's own typing does not count as Claude resuming). `tick` dispatches `silence` to each `working` session with `now - lastOutputAt >= config().silenceMs`. On pty exit: `exit` event, `exitCode` set, settings file cleaned up; the session stays listed.

- [ ] **Step 1: Write the failing tests** with a fake pty factory and a fake clock:

```ts
it('creates an exited session with an error when the folder is missing', () => {
  const s = mgr.create({ kind: 'shell', command: process.execPath, cwd: join(tmp, 'nope') });
  expect(s.status).toBe('exited'); expect(s.error).toMatch(/folder/i);
});
it('creates an exited session when the command does not resolve', () => {
  const s = mgr.create({ kind: 'shell', command: 'definitely-not-a-command-xyz', cwd: tmp });
  expect(s.status).toBe('exited'); expect(s.error).toMatch(/not found/i);
});
it('accepts a folder with spaces and non-ASCII characters', () => {
  const dir = join(tmp, 'café – été'); mkdirSync(dir);
  expect(mgr.create({ kind: 'shell', command: process.execPath, cwd: dir }).status).toBe('running');
});
it('marks a working session maybe-waiting after 5000 ms of silence', () => {
  const s = mgr.create({ kind: 'claude', command: process.execPath, cwd: tmp });
  mgr.hook(s.id, 'UserPromptSubmit', false); clock.advance(4999); mgr.tick();
  expect(mgr.get(s.id)!.status).toBe('working');
  clock.advance(1); mgr.tick();
  expect(mgr.get(s.id)).toMatchObject({ status: 'attention', reason: 'maybe-waiting' });
});
it('output keeps a working session working', () => { /* emit output every 1000 ms for 10 s, tick each time, still working */ });
it('echo within 500 ms of input does not clear maybe-waiting', () => { /* maybe-waiting, input, fake emits output at +100 ms, still maybe-waiting */ });
it('unsolicited output clears maybe-waiting', () => { /* maybe-waiting, output at +600 ms after last input, now working */ });
```

Also: `hook` on an unknown id returns `false`; `ack` moves `attention/finished` to `idle` and fires `onChange`; `update` renames; `remove` kills a running pty and drops it from `list()`; a Claude session's launch args contain `--session-id <its id>` and its settings file is deleted after exit; `statusSince` is unchanged by a repeated identical hook.
- [ ] **Step 2: Run** `npx vitest run tests/server/session-manager.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: session manager`.

---

### Task 7: Auth

**Files:** Create `src/server/auth.ts`; Test `tests/server/auth.test.ts`

**Interfaces:**
- Produces:

```ts
export const COOKIE_NAME = 'cvm_auth';
export function newToken(): string;                                   // 32 random bytes, hex
export function hostAllowed(hostHeader: string | undefined, port: number): boolean;   // 127.0.0.1:<port> or localhost:<port>
export function originAllowed(origin: string | undefined, port: number): boolean;     // http://127.0.0.1:<port> or http://localhost:<port>
export function requestAuthorized(headers: IncomingHttpHeaders, token: string): boolean; // cookie cvm_auth or header x-cvm-token, constant-time compare
export function authCookie(token: string): string;                    // 'cvm_auth=<t>; HttpOnly; SameSite=Strict; Path=/'
```

- [ ] **Step 1: Write the failing tests:** `hostAllowed('127.0.0.1:7717', 7717)` and `'localhost:7717'` true; `'evil.com:7717'`, `'127.0.0.1:7718'`, `undefined` false; `originAllowed('http://127.0.0.1:7717', 7717)` true; `'https://evil.com'`, `'null'`, `undefined` false; `requestAuthorized` true for the right cookie among several cookies, true for the right `x-cvm-token`, false for a wrong token, a token of different length, and no credentials; two `newToken()` calls differ and are 64 hex characters.
- [ ] **Step 2: Run** `npx vitest run tests/server/auth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: local auth checks`.

---

### Task 8: HTTP API and static files

**Files:** Create `src/server/http.ts`; Test `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 6); auth functions (Task 7); `loadConfig`, `saveConfig` (Task 2); `detectProfiles` (Task 3); `parseHookBody` (Task 5).
- Produces:

```ts
export interface HttpDeps { manager: SessionManager; port: number; token: string; hookToken: string; webDir: string; onShutdown: () => void }
export function createRequestHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => void;
```

Routes (JSON in and out):

| Method and path | Auth | Behaviour |
|---|---|---|
| `GET /?token=<t>` | token in query | Set the cookie, 302 to `/`. Wrong token: 403. |
| `GET /api/health` | none | `{ ok: true }` |
| `GET /api/sessions` | user | `SessionInfo[]` |
| `POST /api/sessions` | user | body `CreateSessionRequest` → 201 `SessionInfo` |
| `PATCH /api/sessions/:id` | user | body `{name?, color?}` → `SessionInfo`, 404 if unknown |
| `POST /api/sessions/:id/ack` | user | → `SessionInfo`, 404 if unknown |
| `DELETE /api/sessions/:id` | user | 204, 404 if unknown |
| `GET /api/meta` | user | `{ profiles: Profile[], models: string[] }` — saved profiles followed by built-ins whose id is not already saved |
| `PUT /api/profiles` | user | body `Profile[]` → saves, returns them |
| `POST /api/hooks/:id` | header `x-cvm-hook-token` | `parseHookBody` → `manager.hook`. 204; 400 if body is not JSON or unknown event; 404 if `manager.hook` returns false; 403 on a wrong token |
| `POST /api/shutdown` | user | 204, then `onShutdown()` |
| anything else `GET` | user | static file from `webDir`, falling back to `index.html`; never serves outside `webDir` |

Every request first checks `hostAllowed`, else 403. Request bodies over 1 MB are rejected with 413. Unauthenticated `/api/*` gets 401; an unauthenticated page request gets a 401 page saying "Open CVM by running `cvm`".

- [ ] **Step 1: Write the failing tests** against a real `http.createServer` on port 0 with a `SessionManager` on a fake pty factory. Cover each row's success case plus: wrong `Host` → 403; `/api/sessions` without cookie → 401; hook with malformed body → 400 and no session change; hook for an unknown id → 404; hook for an exited session → 404; hook with the user token instead of the hook token → 403; the user cookie on `/api/sessions` works but the hook token as `x-cvm-token` → 401; `GET /../package.json` (encoded as `%2e%2e`) does not return the file; a 2 MB body → 413.
- [ ] **Step 2: Run** `npx vitest run tests/server/http.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: http api`.

---

### Task 9: WebSocket

**Files:** Create `src/server/ws.ts`; Test `tests/server/ws.test.ts`

**Interfaces:**
- Consumes: `SessionManager`; `hostAllowed`, `originAllowed`, `requestAuthorized`; `ClientMessage`, `ServerMessage`.
- Produces:

```ts
export function attachWebSocket(server: http.Server, deps: { manager: SessionManager; port: number; token: string }): { close(): void };
```

Path `/ws`. The upgrade is refused (socket destroyed after a 403/401 line) unless Host, Origin and the cookie all pass. On connect the server sends `sessions`. On every `manager.onChange` it sends `sessions` to all sockets. `attach` → resize the session to the given size, send `snapshot`, and from then on send `output` for that session to this socket; snapshot and live output must not interleave out of order (subscribe first, buffer until the snapshot is sent, then flush). `detach` or socket close → stop sending that session's output to this socket only. `input` and `resize` go to the manager. Messages that are not valid JSON, have an unknown `t`, or name an unknown session are ignored.

- [ ] **Step 1: Write the failing tests** with the `ws` client against a real server and fake ptys: connect without cookie → refused; with cookie but `Origin: http://evil.com` → refused; a good connection receives `sessions` first; after `attach` the first message for that id is `snapshot` and contains earlier output; later pty output arrives as `output` in order; two clients attached to the same session both receive output, and after the first closes the second still does and the session is still listed (Review Focus 4); `input` reaches the fake pty; `resize` with `cols: 0` leaves the size unchanged; a garbage frame and an `attach` to an unknown id do not close the socket; a status change produces a new `sessions` message on both clients.
- [ ] **Step 2: Run** `npx vitest run tests/server/ws.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat: websocket protocol`.

---

### Task 10: Server entry and `cvm` CLI

**Files:** Create `src/server/index.ts`, `src/cli/cvm.ts`; Test `tests/server/index.test.ts`, `tests/cli/cvm.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// src/server/index.ts
export interface RunningServer { port: number; token: string; stop(): Promise<void> }
export function startServer(opts: { port?: number; ptyFactory?: PtyFactory }): Promise<RunningServer>;
export function findFreePort(start: number): Promise<number>;       // tries start..start+50 on 127.0.0.1
// src/cli/cvm.ts
export function isServerAlive(state: ServerState): Promise<boolean>; // GET /api/health on its port, 1 s timeout, body ok:true
export function main(argv: string[]): Promise<number>;               // exit code
```

`startServer`: load config (print any warning), pick the port, create tokens, build manager + HTTP + WS, listen on `127.0.0.1`, call `manager.tick()` every 1000 ms, write `server.json`. `stop()`: `manager.shutdown()`, close sockets and server, `clearServerState()`. `SIGINT`/`SIGTERM` and `POST /api/shutdown` call `stop()` then exit. When run directly (`node dist/server/index.js --port n`), it starts and stays up.

CLI commands:

| Command | Behaviour |
|---|---|
| `cvm` | If `readServerState()` exists and `isServerAlive`, reuse it. Otherwise clear the stale file and spawn `process.execPath dist/server/index.js` detached, `windowsHide: true`, stdout/stderr appended to `<dataDir>/cvm.log`, `unref()`; wait up to 10 s for a live `server.json`. Print `CVM running at http://127.0.0.1:<port>`, open `http://127.0.0.1:<port>/?token=<token>` unless `--no-open`. Exit 0; exit 1 with the last log lines if the server did not come up. |
| `cvm --port <n>` | As above with that starting port. |
| `cvm --foreground` | Run `startServer` in this process, logs to stdout. |
| `cvm status` | Print running/not running, port, session count. Exit 0 if running, 1 if not. |
| `cvm stop` | `POST /api/shutdown` with `x-cvm-token`; if it does not answer, `process.kill(pid)` only after confirming the health endpoint is dead; clear the state file. |
| `cvm --help`, `cvm --version` | Usage text; version from `package.json`. |

- [ ] **Step 1: Write the failing tests** (all with `CVM_HOME` in a temp dir). `index`: `startServer({ port: <a free port found by the test>, ptyFactory: fake })` writes `server.json` with its own pid and port, serves `/api/health`, and `stop()` removes the file and frees the port; when the default port is occupied by another listener it picks a different one; a corrupt `config.json` does not prevent start. `cvm`: `isServerAlive` is false for a state file whose port is closed; false when the port is open but served by a non-CVM HTTP server answering 404 (Review Focus 5: pid reuse / foreign process); true for a real server; `main(['status'])` returns 1 with no server and 0 with one; `main(['stop'])` stops a running in-process server and clears the file; `main(['--version'])` prints the package version.
- [ ] **Step 2: Run** `npx vitest run tests/server/index.test.ts tests/cli/cvm.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `src/cli/cvm.ts` starts with `#!/usr/bin/env node`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Manual check.** `npm run build`, then `node dist/cli/cvm.js --no-open`; `node dist/cli/cvm.js status` reports running; close the terminal, open a new one, `status` still reports running; `node dist/cli/cvm.js stop`; `status` exits 1.
- [ ] **Step 6: Commit** `feat: server entry and cvm cli`.

---

### Task 11: Web client foundation and TerminalView

**Files:** Create `vite.config.ts`, `src/web/index.html`, `main.tsx`, `App.tsx`, `theme.css`, `api.ts`, `socket.ts`, `store.ts`, `components/TerminalView.tsx`; Test `tests/web/store.test.ts`

**Interfaces:**
- Consumes: `SessionInfo`, `ClientMessage`, `ServerMessage`, REST routes (Task 8), WS (Task 9).
- Produces:

```ts
// api.ts
export const api: {
  meta(): Promise<{ profiles: Profile[]; models: string[] }>;
  createSession(req: CreateSessionRequest): Promise<SessionInfo>;
  updateSession(id: string, patch: { name?: string; color?: string }): Promise<SessionInfo>;
  ackSession(id: string): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  saveProfiles(p: Profile[]): Promise<Profile[]>;
};
// socket.ts
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'down';
export interface Socket {
  send(m: ClientMessage): void;
  subscribe(id: string, cb: (m: { t: 'snapshot' | 'output'; data: string }) => void): () => void;
  onSessions(cb: (s: SessionInfo[]) => void): void;
  onState(cb: (s: ConnectionState) => void): void;
}
export function connect(url: string): Socket;   // backoff 0.5 s doubling to 8 s; 'down' after 5 consecutive failures, keeps retrying every 8 s
// store.ts
export type View = { kind: 'attention' } | { kind: 'grid' } | { kind: 'single'; id: string };
export function selectAttention(sessions: SessionInfo[]): SessionInfo[];  // blocked and maybe-waiting first, then finished; each group oldest statusSince first
export function selectCounts(sessions: SessionInfo[]): { attention: number; working: number; idle: number };
export function useStore(): { sessions: SessionInfo[]; view: View; connection: ConnectionState; setView(v: View): void };
// components/TerminalView.tsx
export function TerminalView(props: { sessionId: string; autoFocus?: boolean; onFocusChange?: (focused: boolean) => void }): JSX.Element;
```

`TerminalView` creates an xterm with the fit addon, on mount fits then sends `attach` with its size, writes `snapshot` (after `reset()`) and `output` to the terminal, sends `input` on data, refits and sends `resize` on container resize (a `ResizeObserver`, debounced 100 ms), and sends `detach` and disposes on unmount. After a reconnect it re-attaches. Vite: `root: 'src/web'`, `build.outDir: '../../dist/web'`, dev proxy for `/api` and `/ws` to `127.0.0.1:7717`. `theme.css` defines every colour as a CSS variable on `:root` (`--bg`, `--panel`, `--text`, `--muted`, `--accent`, `--ok`, `--warn`, `--danger`). `App.tsx` shows a header with the three counts, a "reconnecting…" banner when not `open`, and — when `down` — the full-page message "CVM is not running — run `cvm`".

- [ ] **Step 1: Write the failing tests** for `selectAttention` and `selectCounts`: given sessions `finished@100`, `blocked@300`, `maybe-waiting@200`, `working`, `idle`, shell `running`, `exited`, `selectAttention` returns ids in order `maybe-waiting, blocked, finished`; `selectCounts` is `{ attention: 3, working: 1, idle: 1 }`.
- [ ] **Step 2: Run** `npx vitest run tests/web/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** all files of this task.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Manual check.** `npm run build && node dist/cli/cvm.js`; create a session with `curl`-equivalent `POST /api/sessions` from the browser console (`await fetch('/api/sessions',{method:'POST',body:JSON.stringify({profileId:'builtin-pwsh'})})`), render it by temporarily mounting `TerminalView` for the first session in `App`; type `echo hi`, resize the window and confirm the prompt reflows, reload the page and confirm the screen content returns.
- [ ] **Step 6: Commit** `feat: web client foundation and terminal view`.

---

### Task 12: Sidebar, new-session dialog, terminals grid

**Files:** Create `src/web/components/Sidebar.tsx`, `NewSessionDialog.tsx`, `TerminalsGrid.tsx`; Modify `src/web/App.tsx`

**Interfaces:**
- Consumes: `useStore`, `api`, `TerminalView` (Task 11).
- Produces: `Sidebar()`, `NewSessionDialog(props: { onClose(): void })`, `TerminalsGrid(props: { focusId?: string })`.

Behaviour:
- **Sidebar:** "New session" button; sessions in creation order, each with colour dot, name, status text (`needs you`, `maybe waiting`, `finished`, `working`, `idle`, `running`, `exited`) and, for Claude sessions with a model, the model; a per-session menu with Rename, Colour, Close (Close asks for confirmation unless the session is `exited`); below, the profile list — clicking a profile creates a session from it immediately. Navigation entries "Needs attention" and "Terminals".
- **NewSessionDialog:** profile select (or "Custom command"), name, folder, colour, and — only when the kind is Claude — model: a select of `meta.models` plus "Default" (sends `null`) plus a free-text "Other". "Save as profile" checkbox, which appends to the saved profiles via `saveProfiles`. Submits `createSession`, closes, and switches the view to the new session.
- **TerminalsGrid:** every non-dismissed session in a CSS grid (auto-fit columns, minimum 480 px), each tile with a title bar (colour, name, status, maximise). Maximise switches the view to `{ kind: 'single', id }`, which renders that one terminal full size with a "back to grid" control. An `exited` session with `error` shows the error text instead of a terminal.
- A session is mounted in exactly one place at a time: `App` renders either the attention panel, the grid, or the single view.

- [ ] **Step 1: Implement** the three components and wire them into `App`.
- [ ] **Step 2: Manual check** with `npm run build && node dist/cli/cvm.js`: create a PowerShell session from a built-in profile; create a Claude session choosing a model and confirm with `/status` inside Claude that the model is the chosen one; create one with a folder that does not exist and see the error tile; rename, recolour and close sessions; maximise and return; reload and confirm everything is still there; save a custom profile, restart the server (`cvm stop`, `cvm`), confirm the profile survived.
- [ ] **Step 3: Run** `npx vitest run` — Expected: all PASS (no regressions).
- [ ] **Step 4: Commit** `feat: sidebar, new-session dialog and terminals grid`.

---

### Task 13: Attention panel and outside-the-page signals

**Files:** Create `src/web/components/AttentionPanel.tsx`, `src/web/notify.ts`; Modify `src/web/App.tsx`; Test `tests/web/attention.test.ts`

**Interfaces:**
- Consumes: `selectAttention`, `selectCounts`, `useStore`, `api.ackSession`, `TerminalView`.
- Produces:

```ts
// AttentionPanel.tsx
export function visibleCards(attention: SessionInfo[], previous: string[], focusedId: string | null): string[];
export function AttentionPanel(): JSX.Element;
// notify.ts
export function titleFor(count: number): string;                       // '(2) CVM', or 'CVM' when 0
export function newlyWaiting(prev: SessionInfo[], next: SessionInfo[]): SessionInfo[];
export function requestPermissionOnce(): void;
export function notify(s: SessionInfo, onClick: () => void): void;
```

Behaviour:
- `visibleCards` returns the ids to show as cards: the `selectAttention` order, plus `focusedId` kept at its previous position if it was in `previous` and has left attention (the card must not disappear or move while the user types in it). When focus leaves, the next render drops it.
- Each card: colour, name, model, reason text (`Permission or input needed`, `Possibly waiting`, `Finished, awaiting prompt`), elapsed time updating every second, the live `TerminalView`, and on `finished` cards a "Mark as seen" button calling `ackSession`. Cards are at least 660 px wide by 420 px tall so the terminal holds 80x20; the grid wraps to one column on narrow windows.
- Below the cards, compact rows for working, idle and shell sessions; clicking one opens the single view. With no cards: "Nothing needs you".
- Header counts: Needs attention / Working / Idle. The attention panel is the default view.
- `document.title = titleFor(counts.attention)` on every change.
- `newlyWaiting` returns sessions that are `attention` in `next` and were not `attention` in `prev` (or were absent). For each, when `document.hasFocus()` is false and permission is granted, `notify` shows a browser notification titled with the session name and the reason text; clicking it focuses the window and switches to the attention panel. `requestPermissionOnce` is called the first time the user creates a Claude session.

- [ ] **Step 1: Write the failing tests:**

```ts
it('keeps the focused card in place after it leaves attention', () => {
  expect(visibleCards([a, c], ['a', 'b', 'c'], 'b')).toEqual(['a', 'b', 'c']);
});
it('drops a card that left attention once it is not focused', () => {
  expect(visibleCards([a, c], ['a', 'b', 'c'], null)).toEqual(['a', 'c']);
});
it('does not resurrect a focused id that was never a card', () => {
  expect(visibleCards([a], ['a'], 'z')).toEqual(['a']);
});
it('titles', () => { expect(titleFor(0)).toBe('CVM'); expect(titleFor(2)).toBe('(2) CVM'); });
it('newlyWaiting reports only fresh entries', () => {
  // prev: a working, b attention; next: a attention, b attention, c attention (new) -> [a, c]
});
it('a change of reason within attention is not a new entry', () => {
  // prev: a attention/maybe-waiting; next: a attention/blocked -> []
});
```

- [ ] **Step 2: Run** `npx vitest run tests/web/attention.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat: attention panel, tab title and notifications`.

---

### Task 14: Real-Claude check, packaging gate, README

**Files:** Create `README.md`; Modify `package.json` (`prepublishOnly: npm run build && npm test`)

- [ ] **Step 1: Manual check with real Claude Code.** Start `cvm`, open two Claude sessions and one PowerShell session. For each line, confirm the status shown and that the card appears in the attention panel where stated:

| Action | Expected |
|---|---|
| Session just opened | `idle`, not a card |
| Submit a prompt | `working` |
| Claude asks permission for a tool | card, "Permission or input needed" |
| Approve by typing in the card | `working`; the card does not jump while typing |
| Deny a permission | ends as a card (`finished` or `Possibly waiting`), never stuck on `working` |
| Press Esc during a turn | card within about 5 s, "Possibly waiting" |
| Turn finishes | card, "Finished, awaiting prompt"; browser notification if the tab is in the background; tab title shows the count |
| "Mark as seen" | card leaves; session `idle`; no card reappears after a minute |
| Long tool run (`Start-Sleep 20`) | stays `working` throughout |
| Close the browser tab, reopen | all sessions present with their screens |
| Check `~/.claude/settings.json` modification time | unchanged by CVM |

Record any line that fails; fix before continuing.

- [ ] **Step 2: Packaging gate on Windows.** `npm run build && npm pack`. In an empty folder outside the repository: `npm install -g <path-to-tarball>`, then `cvm`, create a session, `cvm stop`, `npm uninstall -g console-view-manager`. Expected: no compiler invoked during install, the UI loads, the session works.
- [ ] **Step 3: Packaging gate on Linux.** Repeat Step 2 in the environment used in Task 0 Step 2, checking with `cvm --no-open` and `curl http://127.0.0.1:7717/api/health`. If Task 0 recorded "Linux unverified", do not claim Linux support: state it as an open gate in the README and in the final report.
- [ ] **Step 4: Write `README.md`:** what it is, install (`npm install -g console-view-manager`), the commands table from Task 10, where data is stored, the security model in three lines, how session status is detected and its known limits (model shown is the launch value; two tabs on one session share one terminal size; stopping the server ends the sessions).
- [ ] **Step 5: Run** `npx vitest run` — Expected: all PASS.
- [ ] **Step 6: Commit** `docs: readme and packaging checks`.

---

## Findings (written by Task 0)

Verified on 2026-11-17 with Node 24.22.1, npm 11.19.1, Claude Code 2.1.326, Windows 11; Linux checks in WSL Ubuntu with Node 22.12.0.

- **Pty package: `@lydell/node-pty`.** `node-pty` 1.1.0 ships prebuilt binaries for Windows and macOS only: on Linux it runs `node-gyp rebuild` and fails without a toolchain. It also relies on an install script, which npm 11 reports as "not yet covered by allowScripts". `@lydell/node-pty` (1.2.0-beta.18) delivers a prebuilt binary per platform as an optional dependency, with no install script; it installed and spawned a process on Windows and on Linux with no compiler involved. Same API as `node-pty`.
- **Windows needs a resolved path.** `pty.spawn('pwsh', …)` and `pty.spawn('claude', …)` fail ("File not found", error code 2). `pwsh.exe` by full path works. `claude` is a `.cmd` shim: `cmd.exe /d /s /c <path> <args>` works. This is what `resolveExecutable` + `toLaunch` implement.
- **Never call `kill()` on a pty whose process already exited**: node-pty's Windows helper throws "AttachConsole failed".
- **Hooks through `--settings <file>` work**, and they are added to the user's own hooks: the user's `UserPromptSubmit` hook still ran (its output is in the session transcript). `--session-id <uuid>` is honoured (the transcript file carries that id).
- **`Notification` payload** for a permission request: `{"notification_type":"permission_prompt","message":"Claude needs your permission", …}`. The idle reminder was not observed in 80 s of waiting, so its `idle_prompt` type is assumed from documentation, not verified; `parseHookBody` treats anything it cannot classify as a real request.
- **No hook fires after a permission is denied with Esc, nor after a turn is interrupted with Esc** (no `Stop`, no `PostToolUse`). The silence safety net is the only signal for both.
- **Output continuity**: while Claude works, including during a 14 s tool run, the longest gap between output chunks was about 1.3 s; while waiting, there was no output at all for 75–80 s. The 5,000 ms default stands.
- **Nested-session markers.** When CVM is started from inside a Claude Code terminal, hosted sessions inherit `CLAUDE_CODE_CHILD_SESSION` and related variables, and Claude Code then turns transcript saving off for them. CVM strips these variables from the environment of every session it starts (`withoutClaudeSessionMarkers`, added to Task 5).
- **Auto mode.** With the user's default permission mode ("auto"), Claude Code asks no permission and sends no `Notification`; a session then goes `working` → `finished` directly. Nothing to change, but the manual check in Task 14 needs `--permission-mode default` to see a permission card.
- **Linux is verifiable** on this machine through WSL Ubuntu with a Node unpacked in `/tmp/cvmnode` (nothing installed system-wide).
