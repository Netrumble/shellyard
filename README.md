# ShellYard

Run several Claude Code sessions and shells at once, in one browser page, and see at a glance
which of them is waiting for you.

ShellYard starts real terminal processes on your machine (PowerShell, bash, `claude`, anything else)
and shows them in a local web page. Each process is the same one you would get in a terminal
window: your profile, your PATH, your permissions. The page is its screen and keyboard.

> [!NOTE]
> **Is it safe?** ShellYard stays on your machine and is built so that nothing else can use it:
> - **Nothing leaves your PC.** The server listens on `127.0.0.1` only: no other computer can
>   reach it, and ShellYard itself sends nothing to the internet (the programs you run in it, such
>   as Claude Code, connect as they always do).
> - **Only your page gets in.** Every request that does something needs a secret token, created
>   anew at each start; requests from other websites or other host names are refused.
> - **No cookies.** The token is never kept in a cookie, so it is never sent to anything else.
> - **The desktop app is locked down.** Its window cannot run code on your PC by itself, cannot
>   browse to other sites (links open in your browser), and stores no cookies.
> - **Your sessions run as you,** with your usual permissions, never more.
>
> Details, and what ShellYard does not protect against, in [Security](#security).

## Install

ShellYard comes in the browser or as a desktop app (see [Which one to pick](#which-one-to-pick)).
Every way needs Node.js 22 or later on PATH: the server that runs your sessions is a Node process.

### In the browser, from npm (Windows and Linux)

```
npm install -g @talentiaoss/shellyard
shellyard
```

ShellYard opens in your default browser. `npx @talentiaoss/shellyard` runs it without installing.

### As a desktop app, with the setup program (Windows)

1. Download `ShellYard-Setup-<version>.exe` from the
   [latest release](https://github.com/Talentia-Software-OSS/shellyard/releases/latest), with the
   `ShellYard-Setup-<version>.exe.sha256` beside it. To check the download, compare the two in
   PowerShell: `(Get-FileHash .\ShellYard-Setup-<version>.exe -Algorithm SHA256).Hash` must equal
   the first word of the `.sha256` file (case does not matter).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen says "Windows protected your
   PC": click **More info**, then **Run anyway**.
3. Pick the folder (the default is `%LOCALAPPDATA%\Programs\ShellYard`, no administrator rights
   needed) and finish. ShellYard is added to the Start menu and the desktop.

ShellYard then runs in its own window, with an icon in the notification area: closing the window
keeps it there, and it still tells you when a session needs you. To uninstall it, use **Settings →
Apps → Installed apps → ShellYard**. Uninstalling leaves your data in `~/.shellyard`.

### As a desktop app, from npm (Linux, or Windows from a terminal)

```
npm install -g @talentiaoss/shellyard-desktop
shellyard-desktop
```

This is the same desktop app as the Windows setup program, installed the npm way. It is meant for
Linux, where there is no setup program, and for people who prefer to manage their tools with npm.
The first install downloads Electron (about 100 MB). See [desktop/README.md](desktop/README.md).

### Which one to pick

| | `shellyard` (npm) | Setup program (`.exe`) | `shellyard-desktop` (npm) |
|---|---|---|---|
| Where ShellYard shows | a tab in your browser | its own window | its own window |
| Icon in the notification area, notifications when the window is closed | no | yes | yes |
| Start menu and desktop shortcuts | no | yes | no: start it with `shellyard-desktop` |
| Uninstall | `npm uninstall -g @talentiaoss/shellyard` | Settings → Apps | `npm uninstall -g @talentiaoss/shellyard-desktop` |
| Update | `npm update -g @talentiaoss/shellyard` | run the new setup program | `npm update -g @talentiaoss/shellyard-desktop` |
| Systems | Windows, Linux | Windows | Windows, Linux |
| Size | small | about 120 MB (includes Electron) | about 100 MB (downloads Electron) |

On Windows, the setup program is the simplest choice for a desktop window; `shellyard` alone is enough
if a browser tab suits you.

All three are views of the same server: you can use them at once, and they show the same sessions.
Both desktop variants carry their own copy of the server, so you do not need to install `shellyard`
as well; install it only if you also want its commands (`shellyard status`, `shellyard stop`, …).

## Commands

| Command | What it does |
|---|---|
| `shellyard start` | Starts the server in the background (if it is not running) and opens the browser |
| `shellyard` | The same as `shellyard start` |
| `shellyard --port <n>` | Starts on that port, or the next free one (default 7717) |
| `shellyard --no-open` | Does not open the browser |
| `shellyard --foreground` | Runs attached to the terminal, with logs on screen |
| `shellyard status` | Says whether the server is running, where, and with how many sessions |
| `shellyard stop` | Stops the server and every session it hosts |

The server keeps running when you close the terminal you started it from, and your sessions keep
running when you close the browser tab. Open the page again with `shellyard`.

> **Shells stay open until you close them in ShellYard.** Closing the browser tab, or quitting the
> desktop app (also from its tray menu), leaves the server running in the background with every
> shell and Claude Code session in it. A session ends only when you close it with its `✕` in
> ShellYard. `shellyard stop` stops the server and its sessions, but the ones still open then are
> started again at the next start (see below), so close in ShellYard the shells you no longer want.

## What you see

- **Board** — the opening page: one box per area, and in it one light per terminal, with its
  name and state. An area lights up when one of its terminals is waiting for you, and those
  areas come first, so a glance tells who needs you and where. Click a light to open that
  terminal; click the area's name to open all its terminals side by side; drag a light to
  another area to move it there. Drag the corner of an area to resize it; the size is remembered
  in this browser, and a button on the area puts it back to the default.

- **Needs attention** — one card per session waiting for you, each with its live terminal.
  Click into a card and type your answer there. Sessions blocked on a permission or a question
  come first; sessions that finished their turn follow, with a "Mark as seen" button.
- **Terminals** — every session side by side, or one maximised.
- **Sidebar** — all sessions with their status, grouped by area, and your launchers: click one
  to start a session from it.

### Areas

An area is a named group of sessions, typically one piece of work such as a ticket: give it a
name, optionally a ticket code, a folder and a colour; if you choose no colour, one is picked at
random, kept apart from the colours of the other areas. Sessions started inside an area begin in
its folder and take its colour unless you choose otherwise. Create, edit and delete areas on the
board. A session moves to another area, or out of any area, by dragging its light on the board
or with the selector in its title bar. Deleting an area does not stop its sessions. The sidebar
lists the sessions under their area, and the attention panel and the terminals view can be
filtered by area.

(In `config.json` and in the code an area is called a "story", its first name.)

The tab title shows how many sessions are waiting, and a browser notification appears when one
starts waiting while you are looking elsewhere.

When you start a Claude Code session you can choose its model.

### Conversations, and what comes back after a restart

ShellYard can only show terminals it started itself: a session running in another window belongs to
that window and cannot be taken over. What it can do is continue the *conversation*, because
Claude Code saves every conversation on disk. **Conversations** in the sidebar lists the recent
ones, whichever window they were held in, and **Resume here** starts a new session in ShellYard with
the whole conversation in it, in the folder it was held in. Close the conversation in the other
window first.

When the server is stopped and started again, the sessions that were open come back by
themselves: Claude Code sessions resume their conversation, and shells are reopened in the same
folder under the same name and story (a shell's running programs and history are not
recoverable). Sessions you had closed do not come back by themselves. To switch this off, set
`"restoreSessions": false` in `config.json`.

Sessions you closed, or that ended, can be opened again by hand: on the board, the `↺` button
of an area lists them, those closed in that area first and then those closed anywhere else.
**Reopen here** starts the session again in that area: a Claude Code session on the
conversation it was holding, a shell as a new shell in the same folder. The last fifty are kept.
In the **Conversations** view, "Resume into" chooses the area a resumed conversation goes to.

### Schedules

A schedule gives a prompt to a new Claude Code session at set times, as if you had typed it.
**Schedules** in the sidebar lists them; **New schedule** asks for:

- a name (also the name of the sessions it starts) and the prompt, which may have several lines;
- when it runs: on chosen days of the week at a time, every so many minutes or hours (5 minutes
  at least, counted from the last run), once at a date and time, or a cron expression of five
  fields (minute, hour, day of month, month, weekday). Times are the local time of the computer
  ShellYard runs on;
- the Claude Code launcher, optionally a model, an area and a folder;
- how the session asks before acting: as Claude Code is set up, or one of its modes (ask before
  every action, edit files without asking, auto, plan only). In *auto*, Claude Code decides by
  itself which actions are safe and does them without asking, so a scheduled session can act
  while nobody is at the screen; choose it only for prompts you would let run unattended. The
  mode that skips every check (bypass permissions) is not offered.

At its time the schedule opens a session like any other: it is a light on the board, in its
area. The prompt is typed into the terminal when Claude Code is ready for it. If Claude Code asks
for a permission, the session waits under **Needs attention** until you answer.

Each schedule shows its next run and how the last one went, and **History** lists the last
twenty runs: *Prompt given*, *Session open, prompt not given* (Claude Code did not become ready,
or did not confirm it took the prompt), *Could not start* (with the reason) or *Skipped*. **Run
now** starts a run at once without moving the timetable; the **On** box pauses a schedule.

Things to know:

- Schedules run only while ShellYard is running. A run whose time passed while it was not is recorded
  as skipped, unless the schedule is set to run once when ShellYard next starts.
- A run is skipped while the session of the previous run is still working or waiting on a
  permission, so that runs do not pile up.
- Sessions a schedule opened stay open until you close them.
- Deleting an area leaves its schedules, which then run outside any area.
- A schedule is tied to its launcher as it was when the schedule was saved. If the launcher's
  command, arguments or environment change afterwards, its runs fail (*Could not start*) until you
  open the schedule and save it again: an unattended run never starts something you did not see.

### Folders

Wherever a folder is asked for (a new story, a new session, a launcher), you can type the path
or press **Browse** to walk through the folders of the machine and pick one.

Each launcher has a start folder: the folder its sessions open in. The pencil beside a launcher in
the sidebar opens its settings, where you set its name, the start folder and the terminal background. A
built-in launcher can be put back to its default there, and a launcher of your own can be deleted. When a session starts, the folder is the one
chosen in the new-session dialog if any, else the story's folder if the session is in a story
that has one, else the launcher's start folder, else your home folder.

### WSL

On Windows, each WSL distribution installed on the machine is offered as a launcher of its own
("WSL: Ubuntu"), found by asking `wsl.exe`; a distribution added later shows up within a minute.
Its sessions are a Linux shell in that distribution. They start in the session's folder like any
other, which Linux shows under `/mnt/c/...`; type `cd` to go to your Linux home. Docker's own
distributions are not listed.

Claude Code started by hand inside a WSL shell runs, but ShellYard does not see its status: the
status lights, the attention panel and schedules work with the Claude Code launcher, which runs
on Windows.

### The same session in two tabs

A session has one size, and the program in it draws for that size. If the same session is on
screen in two tabs or windows, the one you are using decides the size (it is the one shown, or
the one whose terminal you click), and the other draws the terminal at that size too, even
where it does not fill its own tile or is cut off. Click a terminal to make its page the one
that decides.

### Open in VS Code

Every session has a VS Code button, in its title bar and in its sidebar row. It opens VS Code on
the folder the session was started in, on the computer ShellYard runs on. For a WSL session the folder
is opened inside its distribution, through VS Code's WSL extension, also when it is a Windows
folder (seen there as `/mnt/c/...`) or the Linux home. VS Code is found through its `code` command
on the PATH. The folder is the one the session started in: where its shell has moved to since is
not known to ShellYard.

### Git worktrees

A session in a git repository shows a chip in its title bar, `⎇ branch · worktree`: the branch
checked out in the folder it works in (a short commit id when no branch is), and the name of that
worktree's folder. A Claude Code session follows the folder Claude reports, so the chip changes
when Claude moves to another worktree; for other sessions it shows the folder the session started
in.

The chip's menu lets you move the session to another worktree of the repository, or switch the
branch of its worktree. Moving a session restarts it. For Claude Code that means a new
conversation in the new folder: the old one stays in Conversations, where you can resume it.
Moving is not offered for WSL sessions. Switching away from a commit that is on no branch asks
first, as that commit is then left behind.

**Manage worktrees…** (in the chip's menu) lists the worktrees of the repository. There you
create one, choosing an existing branch or a new one and the folder (by default beside the main
worktree), and delete one. Before deleting, ShellYard asks about what would be lost: sessions
still open in it, uncommitted changes, commits that are on no branch, and the files git ignores
(like `.env`), which are deleted too. Commits on no branch are never lost without that
confirmation: the server refuses to delete such a worktree otherwise. You can also delete the
worktree's branch; if that branch is not merged, the branch is kept and a warning says so.

When other sessions are working in a worktree, moving a session there or switching the branch of
that worktree asks first: they all share the same files, and the branch changes under all of them.

In the new-session dialog, when the folder is in a repository with more than one worktree, a
**Worktree** choice appears under Folder. Pick one to start the session there, in the same
sub-folder if it exists in that worktree. **Manage…** opens the same dialog to create one first.
The choice is not offered for launchers that set their own folder (WSL, `--cd`).

### Terminal background

A terminal normally follows the theme. In a launcher's settings you can give its sessions another
background: a colour, or an image of yours (PNG, JPEG, WebP or GIF, up to 8 MB) shown under a
grey-black veil whose strength you set, so that text stays readable. The image is copied into
ShellYard's own folder. The `◐` button in the title bar of a terminal changes the background of that
one terminal while it is open, without touching the launcher.

### Terminal font and text size

The same two places set the text of a terminal: a launcher's settings (the pencil) for the
sessions it starts from then on, and the `◐` button of an open terminal for that terminal alone,
where the change shows at once. Choose a font from the list, or *Other…* to type the name of any
fixed-width font installed on the computer the browser runs on; choose a size from 10 to 32
pixels. Left alone, a terminal uses Cascadia Mono (or Consolas) at 13. A session keeps its font
when it is closed and reopened, and across a restart.

If terminal text looks small or soft, check the browser's zoom first (Ctrl+0 puts it back to
100%): a page zoomed out draws every letter with fewer pixels. Then raise the size here.

### Usage

The header shows how much of your Claude plan limits is used: the 5-hour limit and the weekly
limit, as two small dials and a row of lights that fills up and turns red near the end. The
Usage view shows the same on large dials, with the time left before each limit resets, and
what the sessions started from ShellYard have cost: today, over 7 days and over 30 days, by model and
by story.

What these figures are, and are not:

- They come from Claude Code itself, and cover all Claude Code use on this machine, in whatever
  window, going back 30 days. Sessions running in ShellYard are counted as they go, from what Claude
  Code reports to ShellYard. Sessions in other windows are read from the conversation files Claude
  Code keeps, where it writes a conversation's cost only when the session ends or is resumed:
  so a session still running in another window is not in today's figure until it ends.
  In the table by model, a cost goes to the model in use when it was reported, so a switch of
  model in the middle of a turn is attributed approximately.
- The cost is Claude Code's own estimate of what the tokens would cost at API prices. On a
  subscription you are not billed that amount; it is a measure of how much you used.
- The limit dials update only while a Claude Code session started here is active. The header
  and the Usage view say how old the reading is, and shows "no data" instead of a number when it has none or when
  the limit has reset since the last reading. Accounts without plan limits (API keys) show
  "no data".

History is kept for 90 days in `usage.json`.

### Instruments and effects

The interface is styled as a sports-car instrument cluster. Beside each session a small rev
counter shows how much its terminal is printing right now; the header has one lamp per session
(green working, amber pulsing when it needs you, chequered when it has finished); a flag passes
over a card when its session finishes.

**Theme** in the header chooses light or dark, or *System* to follow your operating system (the
starting choice). Terminals follow the theme; on the light one, colours that programs chose for
a dark terminal are darkened as needed to stay readable. A third theme, *Talentia*, uses the
colours of the Talentia website: a navy sidebar, magenta for the main actions, a turquoise main
dial, on a light page with dark navy terminals.

The **Effects** menu in the header sets how much of this moves: *Full*, *Reduced* (colours and
values stay, sweeps, pulses and rolling digits go) or *Off* (also no rev counters or small
dials). If your system asks for reduced motion, *Reduced* is the starting choice. **Sound**
adds a soft chime when a session starts waiting for you, and lets the system notification of a
waiting session make its sound; it is on unless you turn it off. With **Sound** off the page is
silent: no chime, and notifications are shown without sound. Sounds a program makes by itself on
the computer, outside the browser, are not the page's to switch off.
Every dial and lamp also gives its value as text; the rev counters are decoration, since each
session's status is already written beside its name.

## How the status of a Claude Code session is known

ShellYard starts `claude` with an extra settings file of its own (passed with `--settings`) that
registers hooks and a status line. Claude Code then tells ShellYard when a prompt is submitted, when a
tool runs, when it asks for permission and when it finishes, and reports its usage figures. Your
own Claude Code settings are not modified, your own hooks keep working, and if you have a status
line of your own it is still shown: ShellYard's passes your status line's output through unchanged.

Claude Code sends no event when you deny a permission or interrupt a turn with Esc. For those
cases ShellYard watches the terminal: a session that is supposedly working but has printed nothing for
5 seconds is shown as "possibly waiting". The delay is `silenceMs` in the config file.

Known limits:

- A terminal has one size. The same session open in two browser tabs will follow whichever tab
  resized last.
- Stopping the server ends the processes of its sessions; see above for what comes back.
- If your Claude Code permission mode is "auto", Claude does not ask for permissions, so sessions
  go from working straight to finished.
- A session that is waiting but keeps printing something at least every 5 seconds (a status
  line on a timer, for example) is not caught by the "possibly waiting" rule.
- A dialog Claude shows before the first prompt (folder trust, login) appears as "idle".
- Of a launcher, the name, the start folder and the terminal background can be changed in the page; its
  command and arguments are edited in `config.json` (under `profiles`, the name launchers keep there). A custom command takes no arguments field yet.
- Some key combinations are taken by the browser before they reach the terminal (Ctrl+W, Ctrl+T,
  Ctrl+N). Ctrl+C copies when text is selected and interrupts otherwise; Ctrl+V pastes.

## Where things are kept

Everything is in `~/.shellyard/`:

| File | Content |
|---|---|
| `config.json` | Your launchers (`profiles`), your stories, the model list, `silenceMs` |
| `server.json` | The running server's port and access token (readable by you only) |
| `shellyard.log` | The server log |
| `sessions.json` | The sessions open right now, to bring them back after a restart |
| `closed.json` | The last fifty sessions that ended or were closed, to reopen them |
| `backgrounds/` | The images uploaded as terminal backgrounds |
| `schedules.json` | The schedules, with the last twenty runs of each |
| `usage.json` | Usage history: cost and tokens per day, model and story (90 days), and how far each of Claude Code's conversation files has been read |
| `open.html` | The private page `shellyard` opens in your browser (readable by you only) |
| `run/` | Per-session settings files, removed when a session ends |

Set `SHELLYARD_HOME` to use another folder.

## Security

Whoever can reach the server gets a shell as you, so:

- it listens on `127.0.0.1` only, never on the network;
- every API request and WebSocket connection needs a random token created at each start (the
  page's own files and the health check, which hold no secret, are served without it).
  `shellyard` hands it to your browser in
  the fragment of the address (the part after `#`, which browsers never send to a server); the
  page keeps it and sends it explicitly with each request. No cookie is used, so the token is
  not sent to other programs listening on this machine;
- the page is opened on a new address at every start, `http://<32 random characters>.localhost:7717`
  (browsers send any `*.localhost` name to this machine by themselves). A fixed address could be
  prepared in advance: whoever holds the port while ShellYard is down (another user of the
  machine can) could leave a service worker there that answers in place of the server at the
  next start and reads the token. Settings kept by the page in the browser (theme, collapsed
  areas, board sizes) therefore start over after each restart of the server;
- requests and WebSocket connections coming from other web pages or other host names are refused.
  The app is served only on the address of the current start; on `127.0.0.1`, which the
  `shellyard` command and Claude Code's hooks use, a page only says how to open it. `localhost`
  is not accepted;
- `shellyard` makes sure the server on the recorded port is really its own (it must answer a
  random challenge with the token) before it sends it the token or stops its process;
- the Windows programs ShellYard runs itself (`wsl.exe`, `cmd.exe`, `taskkill.exe`) are started
  from System32 by full path, never looked up in the folder of a session, and the background
  server runs in `~/.shellyard/`, not in the folder `shellyard` was started from;
- the browser is started on a private file, not on the address, so the token does not appear on
  a command line that other users of the machine could read.

After the server restarts, a tab left open from before is told to run `shellyard` again.

If you edit `config.json` by hand and it is not valid JSON at that moment, ShellYard keeps using the
last settings that were valid and refuses to save changes from the page until the file is fixed.

Any program running as you can read the token from `~/.shellyard/`; ShellYard does not
protect you from your own account. "Readable by you only" means file mode 600 and folder mode
700 on Linux and macOS; Windows ignores those modes, and there the files are protected by the
permissions of your user profile folder.

The desktop app adds no way in:

- its window runs the page isolated from your system (`contextIsolation` and `sandbox` on, no Node
  access), and cannot navigate away from the ShellYard server: links open in your browser;
- it uses the same token as the browser. Its page runs in a storage session of its own, kept in
  memory and emptied before each load, so nothing it stores (a service worker included) outlives
  the app. It stores no cookies;
- the setup program installs for your account only and needs no administrator rights. It is not
  code-signed yet: download it only from this repository's
  [releases](https://github.com/Talentia-Software-OSS/shellyard/releases) and check it against
  its published SHA-256 checksum. It is built from the repository's lockfile, so it contains
  exactly the dependency versions that were tested.

Known gap, not yet closed:

- A program that prints without pause for a very long time is not slowed down to the pace of
  the browser; a stalled tab makes the server use more memory.

Sessions run with the privileges `shellyard` was started with. To get an elevated shell, start `shellyard`
from an elevated terminal.

## Development

```
npm install
npm test            # unit and integration tests
npm run build       # server (tsc) and web UI (vite) into dist/
node dist/cli/shellyard.js --foreground
```

## Licence

MIT. See [LICENSE](LICENSE).
