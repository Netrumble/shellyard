# Git worktrees in ShellYard — design

Date: 2026-11-20 · Status: reviewed; decisions marked *(our call)* were made by the builder

## Intent

Many sessions in ShellYard work on git repositories that have several worktrees (one per piece
of work, so that parallel Claude sessions do not step on each other). Today ShellYard knows only
a folder: the user has to type the worktree's path by hand, cannot see on which worktree or
branch a session is working, and has to leave ShellYard to create, remove or switch them.

The user wants, when a session's folder is in a git repository with worktrees:

1. to pick the worktree when creating a session;
2. to move an open session to another worktree afterwards;
3. to see the worktree and the branch in the session's toolbar;
4. to create and delete worktrees, and switch the branch of a worktree, from ShellYard.

## Goals

- A session in a git repository shows `⎇ <branch> · <worktree folder name>` in its toolbar, kept
  up to date when the branch changes (also when changed from inside the terminal).
- The New session dialog offers a **Worktree** choice when the chosen folder is in a repository
  with more than one worktree.
- An open session can be moved to another worktree: the process is stopped and started again in
  that worktree. A Claude session starts a **new** conversation there (the old one stays on disk
  and can still be continued from the Conversations view).
- A **Worktrees** dialog lists the repository's worktrees and lets the user create one, delete
  one, and switch the branch of one.

## Non-goals

- No other git operations: no commit, stash, pull, push, merge, rebase, status view, diff.
- No automatic stash or discard of changes: when git refuses, ShellYard shows git's message.
- No git for sessions whose folder is not a git repository: they look exactly as today.
- No support for repositories git cannot see from Windows/the host (e.g. a folder that exists
  only inside a WSL distribution): those sessions simply show no git information.

## Anti-goals (would be a failure even if it works)

- Losing work: deleting a worktree with uncommitted changes, or a branch that is not merged,
  without an explicit, specific confirmation from the user.
- Opening a hole: any git call that goes through a shell, or takes a branch name or path from
  the page without validation.
- Slowing the page: no git process per session per second. Git runs on demand; the periodic
  refresh reads files only.

## Approaches considered

1. **Run the `git` CLI from the server** (`execFile`, argument list, short timeout). Uses the
   user's own git, with their config and hooks; the porcelain output of `git worktree list` is
   stable. **Chosen.**
2. Parse `.git` / `.git/worktrees/*` by hand. No process to start, but fragile (packed refs,
   `commondir`, `gitdir` files, bare repositories) and it cannot create or delete anything.
   Used only for the cheap periodic branch refresh (reading `HEAD`), not for listing.
3. A git library (isomorphic-git, simple-git). A new dependency for a handful of commands; the
   first does not fully support worktrees, the second is a wrapper of approach 1.

## Design

### Server: `src/server/git.ts` (new)

- `runGit(args, cwd)`: `execFile('git', args, { cwd, timeout: 15 s, windowsHide: true })`, never
  `shell: true`. Rejects with a `GitError` carrying git's stderr (trimmed) for the page to show.
  If git is not installed, every read function returns `null` (not an error).
- `worktreesOf(folder): Promise<WorktreeListing | null>` — `git -C <folder> worktree list
  --porcelain`, plus `git rev-parse --show-toplevel` to know which worktree the folder is in.
  `null` when the folder is not in a repository.

  ```ts
  interface Worktree {
    path: string;            // absolute, normalised for the platform
    branch: string | null;   // short name; null when detached
    head: string;            // commit sha (short)
    isMain: boolean;         // the first entry of the listing
    locked: boolean;
    prunable: boolean;       // folder gone; shown, can be deleted (pruned)
  }
  interface WorktreeListing {
    current: string;         // path of the worktree the asked folder is in
    worktrees: Worktree[];
  }
  ```
- `dirty(worktreePath): Promise<boolean>` — `git status --porcelain` non-empty. Asked only by
  the Worktrees dialog (per worktree, lazily), never in the background.
- `branches(folder)`: local branches (`git for-each-ref refs/heads --format=%(refname:short)`),
  for the "existing branch" choices.
- `createWorktree(repoFolder, { path, branch, newBranch: boolean, base?: string })`:
  - `newBranch`: `git worktree add -b <branch> <path> <base>`; `base` defaults to the branch (or
    HEAD) of the worktree the dialog was opened from.
  - existing branch: `git worktree add <path> <branch>`.
  - Branch names validated with `git check-ref-format --branch <name>` before use; `path` must be
    absolute and must not exist yet (or be an empty folder).
  - Every user value is passed after the options it belongs to, and a value starting with `-`
    is refused, so nothing can be read as an option.
- `unreachableCommits(worktreePath): Promise<number>` — for a detached worktree, the count of
  `git rev-list HEAD --not --branches --tags --remotes`; 0 when on a branch. *(our call)*
- `removeWorktree(repoFolder, path, { force, deleteBranch })`: refuses the main worktree.
  `git worktree remove [--force] <path>`; a prunable one is removed with `git worktree prune`.
  With `deleteBranch`: `git branch -d <branch>` afterwards (safe delete, never `-D`); if that
  fails the worktree stays removed and git's message is returned as a warning.
- `switchBranch(worktreePath, { branch, create: boolean })`: `git switch <branch>` or
  `git switch -c <branch>`; validated as above. Git's refusal (local changes, branch already
  checked out elsewhere) is returned as the error text.
- `headOf(worktreePath)`: reads the worktree's `HEAD` file (resolving the `.git` file of a linked
  worktree to its gitdir) and returns the branch or the short sha. File reads only.

### Server: session information

- `SessionInfo` gains `git: SessionGit | null`:
  ```ts
  interface SessionGit {
    worktree: string;       // path of the worktree the session's folder is in
    branch: string | null;  // null: detached
    head: string;           // short sha, shown when detached
    isMain: boolean;
    worktreeCount: number;  // > 1: the toolbar offers a switch
  }
  ```
- **Which folder is followed** (decided by the user): for a **Claude** session, the folder Claude
  reports — the `cwd` field of every hook payload (`POST /api/hook/:id`) and the
  `workspace.current_dir` / `cwd` of the status-line payload (`POST /api/status/:id`). The
  manager keeps it as `liveCwd` (absolute path, validated as an existing folder; ignored
  otherwise); when it moves into another worktree (e.g. Claude's `EnterWorktree`), `git` is
  recomputed with `worktreesOf`. For a **shell**, the start folder (ShellYard cannot see a
  `cd`). `SessionInfo.cwd` stays the start folder; `SessionGit.worktree` reflects the live one.
  The "sessions open in it" lists and the warnings below use `SessionGit.worktree`.
- Computed (async, with `worktreesOf`) after a session is created or restarted; the session is
  announced first with `git: null` and announced again when the answer arrives, so a slow git
  never delays a start.
- An exited session (or one that never started) keeps its last `git` value, frozen; it is not
  refreshed. *(builder's call, confirmed in design)*
- Refreshed every 10 s for running sessions with `headOf` (file read). A change of branch is
  announced through the usual change event. The worktree count is recomputed (with git) only
  after a worktree is created or deleted through ShellYard, and when a session is (re)started.

### Server: moving a session to another worktree

- `SessionManager.restartIn(id, cwd)`: keeps the same session id, name, colour, area, launcher,
  model, background and font; stops the process (without reporting it as closed and without
  adding it to the closed list), and starts a new one in `cwd` with the same command and
  arguments. For a Claude session the conversation id becomes a new one (as for a new session),
  never the old conversation.
- If the session started in a sub-folder of its worktree (e.g. `repo/src/web`) and the same
  sub-folder exists in the target worktree, the new process starts there; otherwise at the
  target worktree's root. The same rule applies to the New session dialog.
- Works for exited sessions too (and for those that never started): the move starts the
  process again. *(our call)* For a Claude session the sub-folder rule uses the live folder.
- **Shared-worktree warning** (decided by the user): before moving a session into a worktree,
  and before switching the branch of a worktree, the page shows the other running ShellYard
  sessions whose `SessionGit.worktree` is that worktree, and asks to proceed anyway. A warning,
  not a block. The server needs nothing extra: the page has the session list.
- Not offered for sessions that name their own start folder in their arguments (WSL with
  `--cd`): the toolbar shows the information but no switch.

### HTTP API (all behind the page token, as the other `/api` routes)

| Method & path | Body / query | Does |
|---|---|---|
| `GET /api/git/worktrees?path=` | | `WorktreeListing` or `null` |
| `GET /api/git/branches?path=` | | local branch names |
| `GET /api/git/dirty?path=` | | `{ dirty: boolean, unreachable: number }` for one worktree |
| `POST /api/git/worktrees` | `{ repo, path, branch, newBranch, base? }` | creates; returns the new listing |
| `DELETE /api/git/worktrees` | `{ repo, path, force, deleteBranch }` | removes; returns listing + optional warning |
| `POST /api/git/switch` | `{ path, branch, create }` | switches the branch of the worktree at `path` |
| `POST /api/sessions/:id/worktree` | `{ path }` | `restartIn`; `path` must be one of the session repository's worktrees |

Errors: `400` with git's message for refusals, `404` for an unknown session, `422` when the path
is not a worktree of the session's repository. After create/delete/switch the server refreshes
the `git` field of every session in that repository and announces the change.

### Page

- **Toolbar** (`TileHeader` in `TerminalsGrid.tsx`, and the single-session header): a chip
  `⎇ branch · worktree-name` after the model (the short sha instead of the branch when detached;
  a small "main" mark on the main worktree). Clicking it opens a small menu:
  - the other worktrees of the repository (only if there are any) — choosing one asks
    *"Restart "<name>" in <worktree>? Its process will be stopped. Claude starts a new
    conversation."* and then calls the restart;
  - **Switch branch…** — a small dialog: an existing branch, or a new one; shows git's message
    on refusal;
  - **Manage worktrees…** — opens the Worktrees dialog.
- **New session dialog**: after the folder is chosen (debounced, ~300 ms after typing stops), the
  page asks `GET /api/git/worktrees`. With more than one worktree a **Worktree** select appears
  under Folder, preset to the folder's own worktree, plus a **Manage…** link to the Worktrees
  dialog. A worktree created there is selected on return.
- **Worktrees dialog** (new component): one row per worktree with branch, path, main/locked/
  prunable marks, a "changes" mark (asked lazily) and the ShellYard sessions open in it.
  - **New worktree**: branch (new — default — or existing), base (for a new branch; defaults to
    the current worktree's branch), folder (default `<repo parent>/<repo name>-<branch with / as
    ->`, editable with the folder picker).
  - **Delete** (not on the main worktree): if sessions are open in it, lists them and offers
    "Close them and delete"; if it has changes, a second confirmation that names the loss
    ("Uncommitted changes in <path> will be lost") before sending `force: true`; if it is
    detached with commits on no branch (`GET /api/git/dirty` also returns `unreachable: n`), a
    confirmation that says "n commits on no branch will be lost"; every delete confirmation
    also says that files ignored by git (e.g. `.env`) are deleted too *(our call)*; a "Also delete
    the branch <b>" checkbox (safe delete; git's refusal is shown as a warning).
  - **Switch branch** per row, same small dialog as in the toolbar.
- All texts in English, like the rest of the page.

### Tests

- `git.ts` against temporary repositories made in the test (`git init`, commit, `git worktree
  add`): listing, detached head, `headOf` for main and linked worktrees, create (new / existing
  branch), invalid branch names and `-`-prefixed values refused, delete (clean, dirty refused
  without force, main refused, branch deleted / branch not merged warning), switch (ok, refused
  with changes). Skipped when git is not installed.
- Live folder: a hook / status payload with a `cwd` in another worktree updates `git`; an
  invalid or missing `cwd` changes nothing.
- `SessionManager.restartIn`: works on an exited session; same id and properties, new process in the new folder, sub-folder
  rule, Claude gets a new conversation id, nothing added to the closed list.
- HTTP: token required, validation, error codes.
- Page logic that is pure (chip text, default worktree folder name) in unit tests as for the
  existing web helpers.

## Left to the builder

- Exact component split and CSS, within the existing look (chips like `.model`, dialogs like
  `NewSessionDialog`).
- Whether the 10 s refresh is one timer for all sessions (preferred) or per session.
- How the single-session header reuses the chip (it should be one component).
- README: a short "Git worktrees" section.
