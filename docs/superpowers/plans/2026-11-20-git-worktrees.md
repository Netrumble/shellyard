# Git Worktrees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ShellYard show the git worktree and branch of each session, pick a worktree when creating a session, move a session to another worktree (restart), and create/delete worktrees and switch branches.

**Architecture:** A new `src/server/git.ts` wraps the `git` CLI (`execFile`, never a shell). `SessionManager` gains a `git` field on `SessionInfo` (computed asynchronously through an injectable `gitOf` dependency), a live folder for Claude sessions (from hook/status payloads), a 10 s HEAD refresh, and `restartIn`. New `/api/git/*` routes and `POST /api/sessions/:id/worktree`. On the page: a worktree chip in the session header, a Worktrees dialog, a Switch-branch dialog, and a Worktree select in the New session dialog.

**Tech Stack:** Node ≥ 22, TypeScript (ESM, `.js` import suffixes), vitest, React 18, node-pty (faked in tests).

**Spec:** `docs/superpowers/specs/2026-11-20-git-worktrees-design.md` — read it first; this plan does not repeat its rationale.

## Global Constraints

- Git is always run with `execFile('git', args, { cwd, timeout: 15000, windowsHide: true })`; never `shell: true`, never `exec`.
- Any user value (branch, base, path) starting with `-` is refused; branch names are validated with `git check-ref-format --branch <name>` before use; paths must be absolute.
- Git missing or folder not in a repository → read functions return `null`, never throw.
- The periodic refresh (every 10 s, one timer) reads `HEAD` files only; no git process.
- `git branch -d` only, never `-D`. Main worktree can never be removed.
- All page texts in English. Existing look: chips like `.model`, dialogs like `NewSessionDialog` (`.overlay` + `form.dialog`), portals as in `RenameDialog`.
- Paths compared with `samePath(a, b)` (Task 1): resolved, separators normalised, case-insensitive on win32. Git on Windows prints `C:/x/y`; always convert with `path.resolve`.
- Tests that need git use `describe.skipIf(!hasGit)` where `hasGit` is computed once with `execFileSync('git', ['--version'])` in a try.

## Review Focus

1. **Windows path forms** — git prints `C:/repos/a`, the page sends `c:\repos\a\`: they must be treated as the same worktree (Task 1 test `samePath`, Task 3 test on `worktree` lookup).
2. **Paths and branches with spaces / slashes** — a worktree at `…/my repo-feature-x` for branch `feature/x` must list, create, show and delete correctly (Task 2 test `creates a worktree for a branch with a slash in a folder with a space`).
3. **Worktree folder deleted by hand (prunable)** — listing must not throw, the row shows "prunable", delete prunes it (Task 1 test `marks a worktree whose folder is gone as prunable`, Task 2 test `removes a prunable worktree by pruning`).
4. **Old process exiting after a restart** — the old pty's exit must not mark the restarted session exited nor delete the new Claude settings file (Task 4 test `ignores the exit of the replaced process`).
5. **Live cwd pointing outside any repo / to a non-existent folder** — `git` becomes `null` for the first, unchanged for the second (Task 3 test `live folder outside a repository clears git`).

---

## File map

| File | Responsibility |
|---|---|
| `src/server/git.ts` (new) | All git calls, parsing, validation, `samePath`, `headOf` |
| `src/shared/types.ts` | `SessionGit`, `Worktree`, `WorktreeListing`, `SessionInfo.git` |
| `src/server/claude-launch.ts` | `prepareClaudeLaunch` takes an optional `conversationId` |
| `src/server/session-manager.ts` | `git` field, `setLiveCwd`, `refreshGit`, `refreshHeads`, `restartIn` |
| `src/server/http.ts` | `/api/git/*`, `/api/sessions/:id/worktree`, live cwd from hooks/status |
| `src/server/index.ts` | wires `gitOf`, the 10 s refresh timer |
| `src/web/api.ts` | client calls |
| `src/web/worktrees.ts` (new) | pure page helpers |
| `src/web/components/WorktreeChip.tsx` (new) | chip + menu + move confirmation |
| `src/web/components/BranchDialog.tsx` (new) | switch branch |
| `src/web/components/WorktreesDialog.tsx` (new) | list / create / delete |
| `src/web/components/TerminalsGrid.tsx` | chip in `TileHeader` |
| `src/web/components/NewSessionDialog.tsx` | Worktree select |
| `src/web/theme.css` | chip / menu / row styles |
| `README.md` | "Git worktrees" section |

---

### Task 1: git.ts — reading

**Files:**
- Create: `src/server/git.ts`
- Modify: `src/shared/types.ts` (add `Worktree`, `WorktreeListing`)
- Test: `tests/server/git.test.ts`

**Interfaces:**
- Produces (types in `src/shared/types.ts`):
  ```ts
  export interface Worktree { path: string; branch: string | null; head: string; isMain: boolean; locked: boolean; prunable: boolean }
  export interface WorktreeListing { current: string; worktrees: Worktree[] }
  ```
- Produces (`src/server/git.ts`):
  ```ts
  export class GitError extends Error {}               // message = git's trimmed stderr (or a validation message)
  export function runGit(args: string[], cwd: string): Promise<string>   // stdout; GitError on non-zero exit
  export function hasGit(): Promise<boolean>           // cached
  export function samePath(a: string, b: string): boolean
  export function worktreesOf(folder: string): Promise<WorktreeListing | null>
  export function headOf(worktreePath: string): { branch: string | null; head: string } | null  // sync, file reads only
  export function worktreeStatus(worktreePath: string): Promise<{ dirty: boolean; unreachable: number }>
  export function branches(folder: string): Promise<string[]>
  ```

- [ ] **Step 1: Write the failing tests** in `tests/server/git.test.ts`. A helper `makeRepo(dir)` runs `git init -b main`, sets `user.name`/`user.email` locally, commits one file. Tests:
  - `worktreesOf returns null outside a repository` (a plain temp folder) → `null`.
  - `lists the main worktree and a linked one` — after `git worktree add -b feat ../wt`: `worktrees.length === 2`, `[0].isMain === true`, `[0].branch === 'main'`, `[1].branch === 'feat'`, `samePath([1].path, wtDir)`, `head` matches `/^[0-9a-f]{7,}$/`.
  - `current is the worktree a sub-folder belongs to` — `worktreesOf(join(wtDir,'sub'))` → `samePath(current, wtDir)`.
  - `reports a detached worktree with branch null` (`git worktree add --detach ../det`).
  - `marks a worktree whose folder is gone as prunable` (rm the folder) — no throw, `prunable === true`.
  - `headOf reads the branch of the main and of a linked worktree`, and after `git switch -c other` in the linked one returns `other`; `headOf` on a detached worktree → `{ branch: null, head: <7 chars> }`; on a non-repo → `null`.
  - `worktreeStatus` — clean: `{dirty:false, unreachable:0}`; after writing an untracked file: `dirty:true`; detached with one new commit: `unreachable:1`.
  - `branches lists local branches` → contains `main` and `feat`.
  - `samePath` (no git needed): `samePath('C:/repos/a', 'c:\\repos\\a\\')` true on win32 (`it.runIf(process.platform==='win32')`), `samePath('/a/b','/a/c')` false.
- [ ] **Step 2: Run** `npx vitest run tests/server/git.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement** in `src/server/git.ts`. Parse `worktree list --porcelain` blocks (`worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`, `detached`, `locked`, `prunable`); `current` from `git rev-parse --show-toplevel` run in the folder; `head` shortened to 7. `headOf`: if `<wt>/.git` is a file, read `gitdir: <path>` from it (relative to `wt`), else `<wt>/.git`; read `HEAD`: `ref: refs/heads/<x>` → branch `x`, head from the ref file or `packed-refs` (empty string if not found); else sha. `unreachable`: `rev-list --count HEAD --not --branches --tags --remotes` only when detached. All functions catch "not a repo"/missing git and return `null` as per Global Constraints.
- [ ] **Step 4: Run** the test file — expected PASS. Then `npm run typecheck`.
- [ ] **Step 5: Commit** `git add src/server/git.ts src/shared/types.ts tests/server/git.test.ts && git commit -m "Read git worktrees and branches"`

### Task 2: git.ts — creating, deleting, switching

**Files:**
- Modify: `src/server/git.ts`
- Test: `tests/server/git.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  export function validateBranch(folder: string, name: string): Promise<string>  // returns name; GitError otherwise
  export function createWorktree(repo: string, o: { path: string; branch: string; newBranch: boolean; base?: string }): Promise<WorktreeListing>
  export function removeWorktree(repo: string, path: string, o: { force: boolean; deleteBranch: boolean }): Promise<{ listing: WorktreeListing; warning: string | null }>
  export function switchBranch(worktreePath: string, o: { branch: string; create: boolean }): Promise<void>
  export function defaultWorktreeFolder(mainWorktree: string, branch: string): string  // `${dirname(main)}/${basename(main)}-${branch.replaceAll('/', '-')}`
  ```

- [ ] **Step 1: Write the failing tests:**
  - `creates a worktree on a new branch from a base` → listing has the branch, `headOf(path).branch === 'feat'`.
  - `creates a worktree for an existing branch`.
  - `creates a worktree for a branch with a slash in a folder with a space` (`feature/x`, folder `…/my repo-feature-x`).
  - `refuses a relative path`, `refuses an existing non-empty folder`, `refuses a branch starting with -` and `refuses an invalid branch name` (`'a..b'`) — all reject `GitError`, nothing created.
  - `refuses to remove the main worktree`.
  - `refuses to remove a worktree with changes unless forced` — without force rejects with a GitError; with `force:true` succeeds.
  - `removes the branch too when asked` → `branches()` no longer has it; `keeps the worktree removed and warns when the branch is not merged` (commit in the worktree, then remove with `deleteBranch`) → `warning` non-null, worktree gone, branch still there.
  - `removes a prunable worktree by pruning`.
  - `switches a worktree to an existing and to a new branch`; `reports git's refusal when the branch is checked out elsewhere` (message matches `/already|used by worktree/i`).
  - `defaultWorktreeFolder('C:/r/shellyard','feature/x')` → `resolve('C:/r/shellyard-feature-x')`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Commands: `worktree add -b <branch> -- <path> <base>` / `worktree add -- <path> <branch>`; `worktree remove [--force] -- <path>`; prunable → `worktree prune`; `branch -d -- <branch>` (failure → `warning`, not reject); `switch [-c] <branch>` (validated first, so no `--` needed; `switch` treats `--` differently). `base` defaults to `HEAD`.
- [ ] **Step 4: Run** — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `"Create and remove git worktrees, switch branches"`

### Task 3: Session git info and live folder

**Files:**
- Modify: `src/shared/types.ts`, `src/server/session-manager.ts`
- Test: `tests/server/session-manager.test.ts` (new `describe('git')`)

**Interfaces:**
- Consumes: `WorktreeListing`, `headOf`, `samePath` (Task 1).
- Produces:
  ```ts
  // types.ts
  export interface SessionGit { worktree: string; branch: string | null; head: string; isMain: boolean; worktreeCount: number }
  // SessionInfo gains:  git: SessionGit | null;  liveCwd: string | null   // liveCwd: Claude's reported folder
  // ManagerDeps gains (optional, default: real git):
  gitOf?: (folder: string) => Promise<WorktreeListing | null>;
  headOf?: (worktree: string) => { branch: string | null; head: string } | null;
  // SessionManager:
  refreshGit(id: string): Promise<void>            // recompute from liveCwd ?? cwd
  refreshGitIn(worktreeOrRepo: string): Promise<void>  // every session whose git.worktree is in that repo listing
  setLiveCwd(id: string, cwd: unknown): void       // Claude sessions only; absolute existing folder; triggers refreshGit when the worktree changes
  refreshHeads(): void                             // running sessions: headOf(git.worktree); emit if branch/head changed
  ```
- `SessionGit` is built from a listing: the worktree `w` with `samePath(w.path, listing.current)`; `worktreeCount = listing.worktrees.length`.

- [ ] **Step 1: Write the failing tests** (fake `gitOf`/`headOf` in the manager deps; await with `await vi.waitFor(...)` or a flushed promise):
  - `fills git after the session starts` — `create()` returns `git: null`; afterwards `mgr.get(id).git` equals the fake's worktree; a change event was emitted.
  - `git stays null outside a repository` (fake returns null).
  - `setLiveCwd moves a Claude session's git to the reported worktree` — `liveCwd` set, `gitOf` called with it, `git.worktree` updated.
  - `setLiveCwd is ignored for shells, for relative paths and for missing folders`.
  - `live folder outside a repository clears git`.
  - `refreshHeads updates the branch of running sessions only` — exited sessions keep their frozen `git`.
  - `refreshGitIn updates worktreeCount of every session in the repo`.
  - Existing tests: `toEqual` on whole `SessionInfo` objects must now include `git: null, liveCwd: null` — fix them.
- [ ] **Step 2: Run** `npx vitest run tests/server/session-manager.test.ts` — FAIL.
- [ ] **Step 3: Implement.** After `emitChange()` in `create`, fire `void this.refreshGit(id)` (errors swallowed). Ignore a `gitOf` result that arrives after the session was removed. `setLiveCwd` compares with `samePath`.
- [ ] **Step 4: Run** the whole suite `npm test` — PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `"Track the git worktree and branch of each session"`

### Task 4: Restart a session in another worktree

**Files:**
- Modify: `src/server/claude-launch.ts`, `src/server/session-manager.ts`
- Test: `tests/server/session-manager.test.ts`, `tests/server/claude-launch.test.ts`

**Interfaces:**
- Consumes: Task 3, `samePath`.
- Produces:
  ```ts
  // claude-launch.ts: prepareClaudeLaunch input gains  conversationId?: string  → '--session-id', conversationId ?? sessionId
  // session-manager.ts
  export function mapIntoWorktree(cwd: string, from: string, to: string, exists?: (p: string) => boolean): string
  //   cwd inside `from` and to/<same relative part> exists → that; else `to`
  restartIn(id: string, worktree: string): SessionInfo | null   // null: unknown id
  ```

- [ ] **Step 1: Write the failing tests:**
  - `mapIntoWorktree` — `('/r/a/src/web','/r/a','/r/b', p=>p==='/r/b/src/web')` → `/r/b/src/web`; missing sub-folder → `/r/b`; cwd outside `from` → `/r/b`.
  - `restartIn keeps id, name, colour, area, model, background and font and starts in the new folder` — `ptys.last().opts.cwd` is the target; old pty `killed`.
  - `restartIn gives a Claude session a new conversation` — `conversationOf(id)` differs from before and is a UUID; the launch args contain `--session-id <that uuid>`, not `--resume`.
  - `restartIn adds nothing to the closed list` (no `onClosed` callback).
  - `ignores the exit of the replaced process` — after restart, `oldPty.exit(1)` leaves status not `exited` and the new settings file (`settingsPathFor`-equivalent: check via `existsSync` on the path in the new launch's args) still exists.
  - `restartIn revives an exited session`.
  - `restartIn uses the live folder of a Claude session for the sub-folder rule`.
  - claude-launch: `uses the given conversation id for --session-id`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Extract the pty start from `create` into `private start(entry, cwd, resumeId)` used by both. Add `generation: number` to `Entry`; `wire()` captures it and its callbacks return early when `entry.generation` moved on. `restartIn`: bump generation, kill+dispose old pty, reset status via `initialState(kind)`, `exitCode/error = null`, `liveCwd = null`, for Claude `entry.conversationId = randomUUID()`, `info.cwd = mapIntoWorktree(liveCwd ?? cwd, git?.worktree ?? cwd, worktree)`, start, emit, `void refreshGit(id)`. Do not call `cleanupClaudeLaunch` for the old process after the new settings are written (cleanup before start).
- [ ] **Step 4: Run** `npm test` — PASS; typecheck.
- [ ] **Step 5: Commit** `"Restart a session in another worktree"`

### Task 5: HTTP routes, live folder from hooks, wiring

**Files:**
- Modify: `src/server/http.ts`, `src/server/index.ts`
- Test: `tests/server/http.test.ts` (new `describe('git')`, uses a real temp repo, `skipIf(!hasGit)`)

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces routes (all need the page token; JSON bodies; errors `{ error }`):
  | Route | Response |
  |---|---|
  | `GET /api/git/worktrees?path=` | `WorktreeListing \| null` |
  | `GET /api/git/branches?path=` | `string[]` |
  | `GET /api/git/status?path=` | `{ dirty, unreachable }` |
  | `POST /api/git/worktrees` `{repo,path,branch,newBranch,base?}` | `WorktreeListing` (201) |
  | `DELETE /api/git/worktrees` `{repo,path,force,deleteBranch}` | `{ listing, warning }` |
  | `POST /api/git/switch` `{path,branch,create}` | 204 |
  | `POST /api/sessions/:id/worktree` `{path}` | `SessionInfo` |
  - `GitError` → 400 with its message; unknown session → 404; `path` not among `worktreesOf(session folder)` worktrees (by `samePath`) → 422; non-string/relative `path` → 400.
  - After create/remove/switch: `manager.refreshGitIn(repo or path)`.
  - Hooks (`/api/hooks/:id`) and status (`/api/status/:id`): `manager.setLiveCwd(id, body.cwd ?? body.workspace?.current_dir)`.
  - Note: the spec named it `/api/git/dirty`; use `/api/git/status` (returns more than dirty). Update the spec table in this commit.

- [ ] **Step 1: Write the failing tests:** each route without token → 401; `GET worktrees` on a repo with two worktrees; on a plain folder → `null`; create → 201 and listing has it; bad branch → 400 with message; delete main → 400; switch → 204 and `headOf` changed; `POST /api/sessions/:id/worktree` to a worktree of its repo → 200 and `cwd` changed; to an unrelated folder → 422; unknown id → 404; a hook body with `cwd` of the linked worktree → the session's `git.worktree` becomes it (wait for it).
- [ ] **Step 2: Run** `npx vitest run tests/server/http.test.ts` — FAIL.
- [ ] **Step 3: Implement** the routes next to `/api/folders` (same style: `readJson`, `send`, `HttpError`). In `index.ts`, add `manager.refreshHeads()` to a `setInterval(…, 10_000)` cleared on shutdown like the other timers.
- [ ] **Step 4: Run** `npm test` — PASS; typecheck.
- [ ] **Step 5: Commit** `"Git worktree routes and live folder of Claude sessions"`

### Task 6: Page helpers and API client

**Files:**
- Modify: `src/web/api.ts`
- Create: `src/web/worktrees.ts`
- Test: `tests/web/worktrees.test.ts`

**Interfaces:**
- Produces in `api`:
  ```ts
  worktrees(path: string): Promise<WorktreeListing | null>
  branches(path: string): Promise<string[]>
  worktreeStatus(path: string): Promise<{ dirty: boolean; unreachable: number }>
  createWorktree(b: { repo: string; path: string; branch: string; newBranch: boolean; base?: string }): Promise<WorktreeListing>
  removeWorktree(b: { repo: string; path: string; force: boolean; deleteBranch: boolean }): Promise<{ listing: WorktreeListing; warning: string | null }>
  switchBranch(b: { path: string; branch: string; create: boolean }): Promise<void>
  moveSessionToWorktree(id: string, path: string): Promise<SessionInfo>
  ```
  (`call` must send a body on DELETE; check it does, extend if not.)
- Produces in `src/web/worktrees.ts`:
  ```ts
  export function chipText(git: SessionGit): string          // '⎇ feat · shellyard-feat'; detached: '⎇ 1a2b3c4 · name'
  export function worktreeName(path: string): string         // last segment, either separator
  export function samePathWeb(a: string, b: string): boolean // separators + trailing slash + case-insensitive when either looks like a drive path
  export function sessionsIn(sessions: SessionInfo[], worktree: string, exceptId?: string): SessionInfo[]  // status !== 'exited', git.worktree same
  export function suggestedFolder(mainWorktree: string, branch: string): string  // same rule as defaultWorktreeFolder, keeps the separator style of mainWorktree
  ```
- [ ] **Step 1: Write the failing tests** for each helper (detached text, Windows and POSIX names, `sessionsIn` excludes exited and `exceptId`, `suggestedFolder('C:\\r\\app','feature/x') === 'C:\\r\\app-feature-x'`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; typecheck.
- [ ] **Step 5: Commit** `"Page helpers and client calls for git worktrees"`

### Task 7: Worktree chip, menu, move, switch branch

**Files:**
- Create: `src/web/components/WorktreeChip.tsx`, `src/web/components/BranchDialog.tsx`
- Modify: `src/web/components/TerminalsGrid.tsx` (`TileHeader`: `<WorktreeChip session={session} />` after the model), `src/web/theme.css`

**Interfaces:**
- Consumes: Task 6.
- Produces: `WorktreeChip({ session })`, `BranchDialog({ worktree, onClose })` (also used by Task 8), and `confirmShared(sessions: SessionInfo[], action: string): boolean` exported from `WorktreeChip.tsx`.

- [ ] **Step 1: Implement the chip.** Renders nothing when `session.git` is null. Text `chipText`, `title` = full worktree path; a "main" mark when `isMain`. Click opens a menu (portal, closes on Escape/outside click) that loads `api.worktrees(session.git.worktree)` and shows: other worktrees (only when `worktreeCount > 1`, and not when the session's args contain `--cd`), **Switch branch…**, **Manage worktrees…** (opens `WorktreesDialog` from Task 8 — until then, leave the item out and add it in Task 8).
- [ ] **Step 2: Move.** Choosing a worktree: `confirmShared(sessionsIn(sessions, target, session.id), …)` then `window.confirm('Restart "<name>" in <path>? Its process will be stopped.' + (claude ? ' Claude starts a new conversation.' : ''))` → `api.moveSessionToWorktree`. Errors → `window.alert` like `SessionActions`. (Note: `window.confirm` is already used by `SessionActions.close`, so it works in the desktop app.)
- [ ] **Step 3: BranchDialog.** Form: radio existing/new; existing → select from `api.branches`; new → text input. Before submit, `confirmShared(sessionsIn(sessions, worktree), 'Switch the branch of <name>')`. Shows git's message in `.error` on failure.
- [ ] **Step 4: Verify** `npm run typecheck && npm test`, then run the app (`npm run dev:server` + `npm run dev:web`), open a session in this repository after `git worktree add ../shellyard-try -b try`: the chip shows `⎇ worktree_helper · shellyard`; moving to `shellyard-try` restarts the shell there; `git switch` from the terminal updates the chip within 10 s.
- [ ] **Step 5: Commit** `"Worktree chip in the session header: move and switch branch"`

### Task 8: Worktrees dialog

**Files:**
- Create: `src/web/components/WorktreesDialog.tsx`
- Modify: `src/web/components/WorktreeChip.tsx` (add **Manage worktrees…**), `src/web/theme.css`

**Interfaces:**
- Consumes: Tasks 6–7.
- Produces: `WorktreesDialog({ folder, onClose, onCreated? }: { folder: string; onClose: () => void; onCreated?: (path: string) => void })`.

- [ ] **Step 1: List.** One row per worktree: branch (or short sha), `worktreeName` + full path as title, marks main/locked/prunable, a "changes" mark loaded lazily with `api.worktreeStatus` per row, the names of `sessionsIn(sessions, path)`. Per row: **Switch branch** (BranchDialog), **Delete** (not on main).
- [ ] **Step 2: New worktree form.** Branch: new (default) or existing (select); base for a new branch (select, default the current worktree's branch); folder (input + `FolderPicker`, default `suggestedFolder(main, branch)` updated while the user has not edited it). Submit → `api.createWorktree`, refresh list, `onCreated?.(path)`.
- [ ] **Step 3: Delete flow, in this order:** (a) sessions open in it → `confirm('Close <names> and delete?')`, then `api.deleteSession` for each; (b) `status.dirty` → `confirm('Uncommitted changes in <path> will be lost.')` → `force: true`; (c) `status.unreachable > 0` → `confirm('<n> commits on no branch will be lost.')` → `force: true`; (d) final `confirm('Delete worktree <path>? Files ignored by git (like .env) are deleted too.')` with a "Also delete the branch <b>" checkbox in the dialog row, not in `confirm`. Show `warning` (if any) in the dialog.
- [ ] **Step 4: Verify** typecheck + tests, then in the running app: create `try2` from the dialog, open a session in it, delete it (closes the session after confirmation), check with `git worktree list`.
- [ ] **Step 5: Commit** `"Worktrees dialog: create, delete, switch branch"`

### Task 9: New session dialog and README

**Files:**
- Modify: `src/web/components/NewSessionDialog.tsx`, `README.md`

**Interfaces:**
- Consumes: Tasks 6, 8. The server's `create` stays unchanged: the sub-folder rule is applied on the page.

- [ ] **Step 1: Implement.** Effect on `cwd || story?.cwd || profile?.cwd` debounced 300 ms → `api.worktrees`. When `worktrees.length > 1`, show a **Worktree** select under Folder, preset to `listing.current`, plus a **Manage…** link opening `WorktreesDialog` (its `onCreated` selects the new one). On submit, if a different worktree was chosen: relative = folder minus `listing.current`; if non-empty and `api.folders(chosen + relative)` succeeds, `req.cwd = chosen + relative`, else `req.cwd = chosen`.
- [ ] **Step 2: README** — a short "Git worktrees" section: the chip, moving a session (restarts; Claude starts a new conversation), the Worktrees dialog and what deleting asks before losing work.
- [ ] **Step 3: Verify** typecheck + full `npm test` + `npm run build`; in the app, create a session choosing the second worktree and check the terminal's `pwd`.
- [ ] **Step 4: Commit** `"Pick the worktree when starting a session; document git worktrees"`, including `docs/superpowers/specs/2026-11-20-git-worktrees-design.md` and this plan if not yet committed.
