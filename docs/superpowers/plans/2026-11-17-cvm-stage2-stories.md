# Console View Manager — Stage 2 (Token auth and Stories) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the known security gap of stage 1 (the auth cookie reaches other local ports), then let sessions be grouped into stories.

**Architecture:** The browser no longer holds an ambient credential. The token travels in the URL fragment, is kept by the page in `localStorage` (scoped to scheme + host + port) and is sent explicitly: as the `x-cvm-token` header on every API call and inside the WebSocket subprotocol list. Stories are a small persisted list in `config.json`; a session carries an optional `storyId`; the server pushes the story list to clients over the existing WebSocket.

**Tech Stack:** unchanged from stage 1.

**Spec:** `docs/superpowers/specs/2026-11-17-console-view-manager-design.md` (sections "Security", "Stories", "User interface"). The spec's cookie exchange is superseded by Task 1, decided with the user on 2026-11-17 after the stage 1 review.

## Global Constraints

- Everything in stage 1's Global Constraints still holds (Node >= 22, loopback only, never touch the user's Claude settings, English in the repository, no git operations unless the user asks).
- No cookie is set or read anywhere after Task 1.
- A completion percentage for stories is out of scope (postponed by the user); a story must stay a plain record that can gain fields later.
- Deleting a story never stops a session.
- Story `ticket` is free text; no tracker integration.

## Review Focus

1. **A browser tab holding a token from a previous server run** (the server was restarted): the page says how to get back in (run `cvm`) instead of showing an empty or broken UI. Test in Task 1 (API answers 401; client state `unauthorized`).
2. **A WebSocket opened by a page from another origin that somehow knows the subprotocol name but not the token**: refused. Test in Task 1.
3. **A session whose story is deleted, or whose `storyId` never existed**: the session keeps running and appears ungrouped. Test in Task 2.
4. **A `config.json` written by stage 1 (no `stories` key), and one with malformed story entries**: loads, bad entries dropped, profiles untouched. Test in Task 2.
5. **Saving profiles must not erase stories, and saving stories must not erase profiles.** Test in Task 2.

---

### Task 1: Token auth without cookies

**Files:** Modify `src/server/auth.ts`, `http.ts`, `ws.ts`, `src/cli/cvm.ts`, `src/web/api.ts`, `socket.ts`, `store.ts`, `App.tsx`; Create `src/web/token.ts`; Tests `tests/server/auth.test.ts`, `http.test.ts`, `ws.test.ts`, `tests/cli/cvm.test.ts`, `tests/web/token.test.ts`

**Interfaces:**
- `auth.ts`: remove `COOKIE_NAME`, `authCookie`. `requestAuthorized(headers, token)` accepts only the `x-cvm-token` header. Add `WS_PROTOCOL = 'cvm'`, `WS_TOKEN_PREFIX = 'cvm-token.'`, and `tokenFromProtocols(header: string | undefined): string | null` (parses the comma-separated `Sec-WebSocket-Protocol` value; returns the token only if `cvm` is also offered).
- `http.ts`: static files are served without credentials (still Host-checked); `GET /?token=…` is no longer special; `/api/*` needs the header; no `Set-Cookie` ever.
- `ws.ts`: the upgrade needs Host, Origin, and `tokenFromProtocols` equal to the token; the server selects the `cvm` subprotocol.
- `cvm.ts`: `writeLauncherPage` redirects to `http://127.0.0.1:<port>/#token=<token>`.
- `src/web/token.ts`: `takeTokenFromHash(hash: string): string | null`, `loadToken(): string | null` (reads the fragment first, stores it under `localStorage['cvm-token']`, removes the fragment from the address bar; falls back to the stored one), `wsProtocols(token: string): string[]`.
- `socket.ts`: `ConnectionState` gains `'unauthorized'`; `connect(url, protocols)`.
- `store.ts`: with no token, or after any API call answering 401, the state is `unauthorized` and `App` shows "Open CVM by running `cvm` in a terminal".

- [ ] **Step 1: Write the failing tests.** `auth`: header accepted, a `cookie: cvm_auth=<token>` header rejected; `tokenFromProtocols('cvm, cvm-token.abc')` is `'abc'`, `('cvm-token.abc')` is `null`, `('cvm')` is `null`, `(undefined)` is `null`. `http`: `/` and an asset answer 200 with no credentials; `/api/sessions` with only a cookie answers 401; no response carries `set-cookie`; `GET /?token=<token>` answers 200 with the app and no redirect. `ws`: connects with protocols `['cvm', 'cvm-token.<token>']` and the negotiated protocol is `cvm`; refused with a wrong token (401), with the cookie only (401), with a foreign origin (403). `cvm`: the launcher page contains `/#token=tok123` and not `?token=`. `token`: `takeTokenFromHash('#token=abc')` is `'abc'`, `('#other=1&token=abc')` is `'abc'`, `('')` and `('#x')` are `null`; `wsProtocols('abc')` is `['cvm', 'cvm-token.abc']`.
- [ ] **Step 2: Run** `npx vitest run` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc -p tsconfig.json --noEmit` — Expected: PASS, clean.
- [ ] **Step 5: Browser check** (headless Edge): open the launcher page; the UI loads; the address bar has no token; reload works; a second browser context without the token shows the "run `cvm`" page; a `fetch('/api/sessions')` without the header answers 401.

---

### Task 2: Stories on the server

**Files:** Modify `src/shared/types.ts`, `src/server/config.ts`, `session-manager.ts`, `http.ts`, `ws.ts`, `index.ts`; Create `src/server/stories.ts`; Tests `tests/server/stories.test.ts`, `config.test.ts`, `session-manager.test.ts`, `http.test.ts`, `ws.test.ts`

**Interfaces:**
- `types.ts`: `interface Story { id: string; name: string; ticket: string; cwd: string; color: string }` (empty string = not set); `SessionInfo.storyId: string | null`; `CreateSessionRequest.storyId?: string | null`; `ServerMessage` gains `{ t: 'stories'; stories: Story[] }`.
- `config.ts`: `Config.stories: Story[]` (default `[]`), `normalizeStories(v: unknown): Story[]`.
- `stories.ts`:

```ts
export class StoryStore {
  list(): Story[];
  create(input: { name: string; ticket?: string; cwd?: string; color?: string }): Story;   // throws if name is blank
  update(id: string, patch: { name?: string; ticket?: string; cwd?: string; color?: string }): Story | null;
  remove(id: string): boolean;
  onChange(cb: (stories: Story[]) => void): void;
}
```
  It reads and writes `config.json` through `loadConfig`/`saveConfig`, changing only the `stories` key.
- `session-manager.ts`: `ManagerDeps.stories?: () => Story[]`; `create` honours `storyId` (an unknown id becomes `null`); defaults become: folder = request, else story, else profile, else home; colour = request, else story, else profile, else grey. `update(id, patch)` accepts `storyId: string | null`. New `clearStory(storyId: string): void` ungroups its sessions.
- `http.ts`: `GET /api/stories`, `POST /api/stories` (201; 400 on a blank name), `PATCH /api/stories/:id` (404 unknown), `DELETE /api/stories/:id` (204; calls `manager.clearStory`; 404 unknown). `PATCH /api/sessions/:id` accepts `storyId`. `PUT /api/profiles` changes only the `profiles` key.
- `ws.ts`: sends `stories` after `sessions` on connect and on every story change.

- [ ] **Step 1: Write the failing tests** covering each interface line above, plus the Review Focus cases 3, 4 and 5.
- [ ] **Step 2: Run** `npx vitest run` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and the type check — Expected: PASS, clean.

---

### Task 3: Stories in the UI

**Files:** Modify `src/web/store.ts`, `api.ts`, `selectors.ts`, `components/Sidebar.tsx`, `NewSessionDialog.tsx`, `TerminalsGrid.tsx`, `AttentionPanel.tsx`, `SessionBits.tsx`, `App.tsx`, `theme.css`; Create `components/StoryDialog.tsx`; Tests `tests/web/store.test.ts`

**Interfaces:**
- `selectors.ts`:

```ts
export interface StoryGroup { story: Story | null; sessions: SessionInfo[]; attention: number }
export function groupByStory(sessions: SessionInfo[], stories: Story[]): StoryGroup[];  // stories in their order, each with its sessions (possibly none); then one group with story null for ungrouped sessions, present only if there are any; a session whose storyId matches no story is ungrouped
export function inStory(sessions: SessionInfo[], storyFilter: string | null | undefined): SessionInfo[];  // undefined = all, null = ungrouped, id = that story
```
- `store.ts`: state gains `stories: Story[]`; `View` grid and attention variants gain an optional `storyFilter`.

Behaviour:
- **Sidebar:** "New story" beside "New session". Sessions listed under their story; each story row shows colour, name, ticket, and a badge with how many of its sessions need attention; a story can be collapsed (remembered per browser); story actions: start a session in it, edit, delete. Deleting a story that still has running sessions asks for confirmation and says they will keep running, ungrouped. Clicking a story name opens the Terminals view filtered to it.
- **StoryDialog:** name (required), ticket, folder, colour; used for create and edit.
- **New session dialog:** a Story select (none by default, or the story it was opened from).
- **Tile and card headers:** show the story name; a Story select moves the session.
- **Attention panel:** a filter by story above the cards.

- [ ] **Step 1: Write the failing tests** for `groupByStory` (order, empty story kept, orphan storyId ungrouped, attention counts, no ungrouped group when none) and `inStory` (three cases).
- [ ] **Step 2: Run** `npx vitest run tests/web` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`, type check, `npm run build` — Expected: PASS, clean.
- [ ] **Step 5: Browser check** (headless Edge): create two stories; start sessions in each and one ungrouped; the sidebar groups them; a waiting session raises its story's badge; the story filter narrows grid and attention panel; move a session between stories; delete a story with a running session and see it ungrouped and still running; restart the server and see the stories still listed, empty.

---

### Task 4: Regression and packaging

- [ ] **Step 1:** Full suite on Windows and on Linux (WSL).
- [ ] **Step 2:** Real Claude Code through the UI once more (start, prompt, finished card) to confirm Task 1 did not disturb hooks.
- [ ] **Step 3:** Pack, install the tarball into a clean prefix on Windows and Linux, start, create a session, stop.
- [ ] **Step 4:** Update `README.md`: the Security section (no cookie; remove the closed gap), stories, and the spec's Security section to match.
