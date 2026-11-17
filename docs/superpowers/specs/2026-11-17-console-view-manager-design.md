# Console View Manager — Design

Date: 2026-11-17
Status: approved 2026-11-17. All three stages are built: core, token auth and stories, usage and visual character.

## Intent

One developer runs several Claude Code sessions and shells at the same time, each in its own
terminal window. The cost is attention: a session that is waiting for a permission or has finished
sits unnoticed behind other windows.

Console View Manager (CVM) is a locally installed tool that hosts those terminals itself and shows
them in a browser UI. Its main job is to make "which session needs me right now" visible at a
glance and answerable in place.

## Goals

- Install with `npm install -g console-view-manager`; start with `cvm`; also runnable with `npx`.
- Works on Windows and Linux.
- Create and manage terminal sessions from the browser: Claude Code, PowerShell, and any other
  shell on the machine.
- Show the state of every Claude Code session: working, needs attention, idle, exited.
- A dedicated "Needs attention" panel listing the sessions waiting for the user, where the user
  can answer directly inside each card.
- Sessions keep running when the browser tab is closed or reloaded, and reappear with their
  screen content.
- Saved launch profiles (command + folder + name + colour), started with one click.
- Choose the Claude model for each Claude Code session, at creation or from its profile.
- Group sessions into "stories" (a unit of work, typically one ticket), so several stories can be
  followed side by side.
- A usage dashboard: how much of the Claude plan limits is used, and tokens and estimated cost
  per model, drawn as car-style gauges.

## Non-goals (first version)

- Billing-accurate costs, or usage of other machines or other people. Costs are estimates
  computed locally from this machine's Claude Code data.

- A completion percentage for stories. Explicitly postponed by the user. Stories must be built
  so that a progress value can be added later without reshaping them.
- Jira (or any tracker) integration. A story's ticket code is plain text.

- Access from another device. The server is loopback-only. The code must not make this
  impossible later (auth and transport are isolated in one module), but nothing is built for it.
- Sessions surviving a restart of the CVM server. Stopping `cvm` ends its terminals.
- "Approve / Deny" buttons that interpret Claude's question.
- Search in output, themes, custom keyboard shortcuts, a desktop (Electron) wrapper, multi-user.
- State detection for plain shells (they are only "running" or "exited").

## Anti-goals

- Never write to the user's global or project Claude Code settings.
- Never listen on a non-loopback interface.
- Never show a session as "working" while it is actually waiting for the user. A missed
  "needs attention" is the worst failure of this product; when in doubt, show it as waiting.
- Never present an estimate as an exact figure. Estimated costs are labelled as estimates, and
  a gauge with no data shows "no data", never zero.

## Constraints

- Node.js >= 22. Developed on Node 24.22, npm 11.19, Claude Code 2.1.326, Windows 11.
- One npm package. The web UI is built before publishing and shipped inside the package; an
  installing user compiles nothing for the frontend.
- The package name `console-view-manager` was free on npm on 2026-11-17. Command name: `cvm`.
- Everything in the repository is written in English.

## Approaches

### Runtime (decided by the user: Node.js)

| Approach | Trade-off |
|---|---|
| **Node.js + node-pty + xterm.js** (chosen) | The most proven combination (VS Code's terminal). Node is already present wherever Claude Code is. Installable with npm, which the user requires. The native module `node-pty` needs care in packaging. |
| Go + xterm.js | Single binary, trivial install. Weaker Windows pseudo-terminal support, and not an npm-native install. |
| .NET + xterm.js | The user's daily stack. Less mature terminal libraries, more hand-written code, not an npm-native install. |

### Detecting Claude Code's state (my call)

| Approach | Trade-off |
|---|---|
| **Claude Code hooks** (chosen) | Claude Code reports its own events. Accurate, and independent of how the screen looks. Requires passing per-session settings at launch. |
| Parsing terminal output | No integration needed, but breaks whenever Claude Code changes its UI text, and guesses wrong on ambiguous screens. |

### Answering from the attention panel (decided by the user: option 1)

| Approach | Trade-off |
|---|---|
| **The card is the real terminal** (chosen) | Click into the card and type. Works for every kind of question because nothing is interpreted. |
| Approve / Deny buttons | More convenient, but must recognise the question and simulate keys; breaks when Claude Code's menus change. Can be layered on later. |
| View only, click to open | Simplest, but one extra step for every answer. |

## Architecture

```
 browser (React + xterm.js)
      │  HTTP (REST)  +  one WebSocket per tab
      ▼
 cvm server (Node, 127.0.0.1 only)
   ├─ auth        token + origin/host checks
   ├─ sessions    session registry, state machine, events
   ├─ pty         node-pty processes + headless terminal mirror
   ├─ hooks api   receives Claude Code hook events
   └─ config      profiles in the user's home folder
      │ spawns
      ▼
 claude / pwsh / bash …   ──(hook script)──▶ hooks api
```

Technology (my calls): TypeScript everywhere; `node:http` + `ws` on the server; React + Vite on
the client; `@xterm/xterm` with the fit addon in the browser; `@xterm/headless` +
`@xterm/addon-serialize` on the server; `node-pty` for pseudo-terminals; Vitest for tests.

### Sessions

A session is one pseudo-terminal process plus its metadata:

- `id` (UUID), `kind` (`claude` | `shell`), `name`, `color`, `cwd`, `command`, `args`
- `storyId` (optional), `model` (Claude sessions only, optional)
- `status`, `statusReason`, `statusSince`
- `cols`, `rows`, `exitCode`

For every session the server keeps a headless xterm instance fed with the same bytes as the
process output. When a browser attaches, the server sends the serialized screen and scrollback
from that mirror, then streams live output. This is what makes reload and re-open work, and it
restores full-screen programs such as Claude Code correctly (a raw byte replay does not).
Scrollback kept per session: 5,000 lines.

Size: a pseudo-terminal has exactly one size. Every mounted view fits its xterm to its container
and sends a resize; the last resize wins. Within one browser tab a session is mounted in only one
place at a time. Two browser tabs showing the same session will fight over size; that is accepted.

When a process exits, the session stays listed as `exited` with its final screen until the user
dismisses it. Stopping the server (Ctrl+C or `cvm stop`) kills all session processes.

### Stories

A story is a named container for sessions: `{ id, name, ticket?, cwd?, color? }`.

- A session belongs to one story or to none.
- Stories are saved in the config file and survive a server restart; their sessions do not, so
  after a restart a story is listed empty and ready to receive new sessions.
- A session created inside a story starts in the story's folder unless the user picks another,
  and inherits the story's colour unless it has its own.
- A session can be moved to another story, or out of any story, at any time.
- Deleting a story does not stop its sessions; they become ungrouped. The UI asks for
  confirmation when the story still has running sessions.
- A story's status is derived from its sessions: it needs attention if any of them does.

### Model selection

A Claude session can be given a model. CVM passes it as `claude --model <value>`; with no model
set, the flag is omitted and Claude Code uses the user's own default. The UI offers a list plus
free text. The list is read from the config file (`models`), seeded with the aliases `opus`,
`sonnet`, `haiku`, so it can be updated without a new release. The model is fixed at launch:
changing it later inside Claude (`/model`) is not tracked, and the card shows the launch value.

### Usage

**As built (stage 3, 2026-11-17).** A spike showed that Claude Code hands a status-line command
everything needed: `rate_limits` (5-hour and weekly percentages with reset times), the session's
cumulative estimated cost, its token totals and the model in use. CVM therefore registers a
status-line command in the per-session settings file; it forwards the payload to the server and
prints whatever the user's own status line prints. Running totals become amounts per day,
attributed to the model and the story of the moment, kept for 90 days in `usage.json`.
Consequences: there is no transcript parsing and no price table (the cost is Claude Code's own
estimate); only sessions started from CVM are counted; there is no budget fallback (without
limit data the dials show "no data"); the model shown on a session follows `/model`. Today's
cost is shown as an odometer panel, not a needle dial, because a cost has no full scale.

**Revised the same day**, after the first use showed "today's cost" at zero while Claude Code
had been used all day in other windows: costs now have two sources. Sessions running in CVM are
counted live from their status reports. All other use is read from Claude Code's transcripts,
which hold a conversation's running cost per model in "cost-state" lines; these are written
only when a session ends or is resumed, so a session running in another window is counted when
it ends. The two sources describe the same running total of a conversation, and the stretch of
it already counted live is left out when the transcript later covers it. There is still no
price table: every figure is Claude Code's own.

The text below is the original design, kept for the record.

Two different things are shown, from two different sources.

**Tokens and estimated cost, per model.** Claude Code writes every conversation to transcript
files under `~/.claude/projects/`, and each assistant message records its model and token counts
(input, output, cache write, cache read). The server reads these files incrementally (remembering
how far it read each file), de-duplicates repeated entries, and aggregates by model, by day, and
by session. Cost is tokens multiplied by a price table. This covers all Claude Code use on the
machine, including sessions not started from CVM.

- CVM starts Claude sessions with `claude --session-id <uuid>`, so a transcript can be tied to
  its CVM session and therefore to its story. Usage per story is the sum of its sessions,
  including sessions that have since ended.
- The price table lives in the config file (`prices`, per model, per million tokens, for each
  token type) so it can be corrected without a release. It must be filled from Anthropic's
  published pricing at build time, not from memory. A model missing from the table shows its
  tokens and "price unknown", and is left out of cost totals with a visible note.
- On a subscription plan nothing is billed per token; the figure is "what this would cost at API
  prices" and is labelled so.

**Plan limits, as percentages.** The share used of the 5-hour and weekly limits, and when each
resets. Claude Code is believed to expose these in the data it passes to a status-line command
(`rate_limits`), for subscription accounts. CVM would register its own status-line command in
the per-session settings; that command forwards the data to the server and then runs the user's
own status-line command, if any, passing its output through unchanged, so the user's status line
keeps working. This needs verifying first (see Risks). If the data is not available, the limit
gauges are replaced by gauges against a budget the user sets (tokens or estimated cost per day
and per week), and the UI says which kind it is showing.

Limit percentages only update while at least one CVM-launched Claude session is active; the
dashboard shows how old the reading is.

### State machine (Claude Code sessions)

| Status | Meaning | Entered on |
|---|---|---|
| `idle` | Nothing pending: just started, or finished and acknowledged by the user | session start; user acknowledges a finished session |
| `working` | Claude is processing | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` |
| `attention` | Waiting for the user | `Notification` (reason: `blocked` — permission or input needed), `Stop` (reason: `finished`), silence safety net (reason: `maybe-waiting`) |
| `exited` | Process ended | pty exit |

Two reasons for `attention` are treated differently everywhere in the UI (my call):

- `blocked` and `maybe-waiting`: Claude cannot continue without the user. Always listed first.
- `finished`: Claude completed its turn. Listed after the blocked ones, and the user can
  acknowledge it ("Mark as seen"), which moves it to `idle` so that read-and-done sessions do
  not bury the ones that are blocked. Sending a new prompt also clears it (`UserPromptSubmit`).

One optimistic rule: when a session is in `attention` with reason `blocked` and the user sends
input to it, it moves to `working` immediately. A session in `attention` because it finished
stays there until `UserPromptSubmit` or an acknowledgement, so typing a half-written prompt does
not hide it.

Safety net (my call). Hooks do not cover every way Claude can end up waiting: an interrupted
turn (Esc), a denied permission, the folder-trust dialog, a login prompt. While Claude is
working it redraws its progress indicator continuously, so a session that is `working` and has
produced no terminal output for 5 seconds (configurable) moves to `attention` with reason
`maybe-waiting`. Any later hook event or new output while `working` overrides it. This is a
timer on output activity, not interpretation of screen text, and it exists to honour the
anti-goal: a false "maybe waiting" is acceptable, a missed wait is not. The threshold and the
assumption about continuous redraw must be checked against real Claude Code during the build.

Shell sessions have only `running` and `exited`.

### Hook integration

CVM launches Claude Code as:

```
claude --settings <json>
```

with environment variables `CVM_SESSION_ID`, `CVM_PORT`, `CVM_HOOK_TOKEN` set on the process.
The settings JSON registers command hooks for the events above. Each hook runs
`node "<package>/dist/hook.js"`, a tiny script shipped in the package that reads the hook's JSON
from stdin and POSTs it to `http://127.0.0.1:<port>/api/hooks/<sessionId>`. The script must exit
0 quickly and silently even when the server is unreachable, so it can never block or break a
Claude session.

`--settings <file-or-json>` is confirmed present in Claude Code 2.1.326. To verify during the
build, before relying on it: that hooks passed this way are added to the user's own hooks rather
than replacing them, and the exact payload of `Notification` (to tell a permission request from
other notifications). If inline JSON is awkward to quote on Windows, write the settings to a
temp file per session and pass its path.

### Security

Anyone who can reach the server gets a shell as the user, so even on loopback:

- Bind to `127.0.0.1` only.
- A random token is generated at server start. `cvm` writes a private page (mode 600) that
  redirects to `http://127.0.0.1:<port>/#token=…` and opens the browser on that file, so the
  token is neither on a command line nor sent to any server. The page stores it in
  `localStorage` (private to this exact origin, port included) and clears the fragment.
- No cookie is used: a cookie for `127.0.0.1` is sent by the browser to every port on the
  machine. (Revised on 2026-11-17 after the stage 1 review; the first design exchanged the
  token for a cookie.)
- Every API request must carry the token in the `x-cvm-token` header; the WebSocket offers it
  in its subprotocol list. WebSocket upgrades also check that `Origin` is the server's own
  origin, and every request checks the `Host` header (DNS-rebinding protection). The app's
  static files are served without a token: they hold no secret.
- The hook endpoint accepts only the separate hook token, which can do nothing but post events.

### Process lifecycle and CLI

The server runs as a detached background process (my call), so closing the terminal that started
it does not kill the hosted sessions.

- `cvm` — start the server in the background on the default port (7717, or the next free one),
  print the address, open the browser, and return. If a CVM server is already running, only
  open the browser to it. A `server.json` whose process is gone is treated as stale and replaced.
- `cvm --port <n>`, `cvm --no-open`.
- `cvm --foreground` — run attached to the terminal with logs on stdout, for debugging.
- `cvm status` — say whether the server is running, on which port, with how many sessions.
- `cvm stop` — stop the running server and its sessions.
- Server logs go to `~/.console-view-manager/cvm.log`.
- Running state (pid, port, token) lives in `~/.console-view-manager/server.json`, readable by
  the user only. Profiles live in `~/.console-view-manager/config.json`.

### Profiles

A profile is `{ name, kind, command, args, cwd, color, env, model? }`. On first run CVM offers built-in
profiles for what it finds on the machine: Claude Code, PowerShell 7 (`pwsh`), Windows PowerShell,
`cmd`, Git Bash on Windows; `$SHELL` and `bash` on Linux. The user can create, edit and delete
profiles from the UI.

## User interface

Layout: a permanent sidebar on the left, a main area on the right.

**Sidebar.** "New session" and "New story" buttons; the sessions grouped under their story, with
ungrouped sessions last; the saved profiles. Each session shows colour, name and status; each
story shows its name, ticket code and how many of its sessions need attention. Stories can be
collapsed. Clicking a session opens it in the main area; clicking a story shows only that
story's sessions in the Terminals view.

```
▾ HCM-1234 Payroll export      ● 1
    ● claude-backend    needs you
    ◐ claude-tests      working
    ○ pwsh              running
▸ HCM-1240 Absence fix
  Ungrouped
    ○ PowerShell        running
```

**New session dialog.** Profile (or custom command), story, folder, name, colour, and for Claude
sessions the model.

**Needs attention (home view).**

```
┌──────────────────────────────────────────────────────────────┐
│  Needs attention (2)          Working (1)        Idle (1)    │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────┐  ┌──────────────────────────┐   │
│ │ ● hcm        for 4 min   │  │ ● traffic-mgr  for 40 s  │   │
│ │ Permission requested     │  │ Finished, awaiting prompt│   │
│ │ ┌──────────────────────┐ │  │ ┌──────────────────────┐ │   │
│ │ │  live terminal       │ │  │ │  live terminal       │ │   │
│ │ │  (click and type)    │ │  │ │  (click and type)    │ │   │
│ │ └──────────────────────┘ │  │ └──────────────────────┘ │   │
│ └──────────────────────────┘  └──────────────────────────┘   │
│  Working                                                     │
│  ◐ worktree-1240                                  for 2 min  │
└──────────────────────────────────────────────────────────────┘
```

- One card per session in `attention`: blocked ones first, then finished ones, each group oldest
  wait first. Finished cards carry a "Mark as seen" button.
- The count in the panel header, the tab title and the story badges counts all `attention`
  sessions; browser notifications fire for every entry into `attention`.
- The panel covers all stories; a filter narrows it to one story.
- Each card shows name, story, model, colour, reason, elapsed time, and the real terminal, large enough to
  read and type in (at least 80 columns by 20 rows; cards wrap to fewer per row on narrow
  windows).
- A card stays in place while the user is typing in it, even after its status changes, and
  leaves the panel only when focus moves away. Cards must not jump under the user's hands.
- Below the cards, compact rows for working, idle and shell sessions; clicking one opens it.
- An empty panel says so plainly ("Nothing needs you").

**Terminals view.** All open sessions in a resizable grid, with the option to maximise one.

**Usage view.** Styled as a sports-car instrument cluster: dark panel, round dials with a needle,
a red zone at the top of the scale.

```
┌──────────────────────────────────────────────────────────────┐
│      ╭───────╮        ╭───────╮        ╭───────╮             │
│     ╱  5-hour ╲      ╱ weekly  ╲      ╱  today  ╲            │
│    │    62%    │    │    38%    │    │  $14.20   │           │
│     ╲ resets  ╱      ╲ resets  ╱      ╲  est.   ╱            │
│      ╰─1h 12m╯        ╰─Thu───╯        ╰───────╯             │
│                                                              │
│  Model        Today tokens   Today est.   7 days est.        │
│  opus         1.2M           $9.80        $61.40             │
│  sonnet       3.4M           $4.10        $22.75             │
│  haiku        0.6M           $0.30        $1.90              │
│                                                              │
│  Story                       Today est.   Total est.         │
│  HCM-1234 Payroll export     $8.20        $47.10             │
│  HCM-1240 Absence fix        $3.90        $12.30             │
└──────────────────────────────────────────────────────────────┘
```

- Two large dials for the plan limits, one for today's estimated cost.
- A table per model and a table per story; a period switch (today / 7 days / 30 days).
- The two limit dials also appear small in the page header on every view, turning amber and
  then red as they approach the limit.
- The dial styling is decoration around real numbers: every dial also shows its value as text.

**Signals outside the page.** The browser tab title shows the count (`(2) CVM`). A browser
notification fires when a session enters `attention` while the tab is not focused; clicking it
focuses the tab and that session. Notification permission is asked for the first time the user
creates a Claude session, not on page load.

## Visual character

The whole UI borrows from a sports-car instrument cluster, not only the Usage view: dark
panel, a single accent red, amber for warnings, fine dial markings. The user asked for effects
that are pleasant and surprising ("stupiscimi"); the set below is my call. Generic sports-car
styling only: no real car maker's name, logo or badge.

Effects that carry information:

- **Rev counter per session.** Each session card and sidebar row has a small tachometer whose
  needle follows how much the terminal is producing right now. A working Claude session visibly
  "revs"; a stalled one drops to zero, which is the same signal the safety net uses.
- **Warning lamps.** The page header has one lamp per session, like the lamp row of a
  dashboard: off when idle, steady green when working, pulsing amber when blocked, a small
  chequered flag when finished. Hovering a lamp names the session; clicking opens it.
- **Shift lights.** A row of LEDs in the header fills green, then amber, then red as the 5-hour
  limit is consumed, and blinks when it passes 90%.
- **Needles with weight.** Dial needles move with spring inertia and a slight overshoot, never
  jumping to a value.
- **Odometer digits.** Token and cost figures roll like a mechanical odometer when they change.

Effects for delight:

- **Ignition.** On page load every dial sweeps to full scale and back before settling on its
  real value, like a cluster self-test at key-on. Under one second, and never blocks input.
- **Start button.** "New session" is a round engine-start button; the new terminal's card
  fades in with a short rev of its tachometer.
- **Chequered flag.** When a session finishes, a flag sweeps once across its card.
- **All clear.** When the last waiting session is handled, the "Nothing needs you" state arrives
  with a brief flourish.
- **Sound, off by default.** An optional soft chime on entering attention.

Rules:

- No effect is drawn over, or delays interaction with, a terminal.
- A setting offers "full / reduced / off"; the system's reduced-motion preference selects
  "reduced" by default, which keeps colours and values but removes sweeps, pulses and rolling.
- Every effect has a plain-text equivalent already on screen; nothing is conveyed by motion or
  colour alone.
- Animations use transforms and SVG only and must not make typing in a terminal lag, even with
  ten sessions open.

## Error handling

- Command not found / spawn failure: the session is created in `exited` with the error text shown
  in place of the terminal; nothing crashes.
- WebSocket drop: the client reconnects with backoff and re-attaches; a visible "reconnecting"
  indicator, no silent stale screen.
- Server stopped while a tab is open: after reconnection attempts fail, the already-loaded page
  shows "CVM is not running — run `cvm`". No offline page or service worker; a fresh page load
  against a stopped server simply fails in the browser.
- Port in use by something else: pick the next free port and print it.
- Usage data unreadable or absent: the Usage view shows "no data" per dial or table, and the
  rest of the app is unaffected.
- Corrupt config file: start with defaults, keep the bad file aside as `config.json.bad`, and
  say so in the terminal.

## Testing

- Unit: the state machine (every event from every state, including the optimistic rule, the
  acknowledgement and the silence safety net with a fake clock), config loading, auth checks
  (token, origin, host), usage aggregation from sample transcript lines (de-duplication,
  unknown model, malformed line).
- Integration: start the server, create a real shell session, send input, read output over the
  WebSocket; attach a second client and check it receives the restored screen; post fake hook
  events and check status changes and ordering.
- Hook script: runs against a stopped server and exits 0 without output.
- Packaging: `npm pack`, install the tarball globally in a clean environment, run `cvm`, on both
  Windows and Linux. This is a release gate.
- Manual check with real Claude Code: permission prompt, finished turn, and prompt submission
  each move the session to the right status.

## Risks to verify early

1. **`node-pty` install on Linux.** Version 1.1.0 is the current release. If it does not ship a
   prebuilt binary for Linux, a global install would need a compiler. Check first; the fallback
   is a fork that publishes prebuilt binaries for all platforms (for example
   `@lydell/node-pty`).
2. **Launching `claude` on Windows through node-pty.** The command may be a `.cmd` shim, which
   needs resolving to a real executable or launching through the shell.
3. **Hook merge behaviour and `Notification` payload**, as described above.
4. **Plan-limit data.** Confirm that the status-line input of the installed Claude Code carries
   limit percentages and reset times, that a status line passed through `--settings` takes
   effect, and that wrapping the user's own status line works on Windows and Linux. If any of
   these fails, use the budget gauges described under Usage.
5. **Transcript format.** Confirm the fields used for usage (model, the four token counts, a
   stable id for de-duplication) against real transcript files; the format is not a documented
   contract and may change between Claude Code versions, so the reader must skip lines it does
   not understand instead of failing.

## Left to the builder

- WebSocket message framing (control messages vs terminal data).
- Client state management and component structure.
- Exact REST route shapes beyond: list/create/update/delete sessions, read/write profiles,
  post hook events.
- Visual styling, within the layout above.
- Repository layout (suggested: `src/server`, `src/web`, `src/hook`, built to `dist/`).

## Board of areas (added 2026-11-17, approved in conversation)

**Intent.** With several tickets in progress at once, each with its own sessions, the user wants
to see the work from above: which piece of work has someone waiting, without opening terminals.

**What it is.** A board with one box per area and, in each, one light per terminal showing its
name and state — a stand-in for the terminal, not the terminal. An area is lit when one of its
terminals is waiting, and lit areas come first. Clicking a light opens that terminal; clicking
the area's name opens all its terminals; dragging a light to another area moves the session.
Areas are created, edited and deleted on the board. It is the opening page.

**Approach.** An area is the existing "story" (one session, one area), so nothing new is stored:
the board is another view of the same data. The alternative, a second grouping beside stories,
was dropped once the user described an area as a ticket. In the interface the word is "area",
because for this user a "story" is the work launched on a ticket and some sessions carry that
name; the stored data and the code keep "story".

**Not included.** The agents a Claude session starts are not shown as lights of their own: a
session with agents at work is simply "working". The user was offered that as a later addition,
which first needs a check that Claude Code reports reliably when an agent starts and ends.
Areas cannot be reordered by hand.
