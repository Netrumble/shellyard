# Sidebar, Ordering and Sounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-controlled order of areas, sessions and launchers (drag on board and sidebar), a foldable sidebar with icons and foldable sections, and notification sounds per event with an override per area, silent while ShellYard has the focus.

**Architecture:** Orders live on the server (stories array order in config, session manager order, new `profileOrder` in config) behind three `PUT …/order` routes; the page computes new orders with one pure helper and sends them. Sound files live in the data folder like backgrounds; settings in config and on `Story`. A pure `pickSound` decides what plays; a small player turns stored sounds into object URLs.

**Tech Stack:** Node ≥ 22, TypeScript ESM (`.js` import suffixes), vitest, React 18, HTML5 drag and drop.

**Spec:** `docs/superpowers/specs/2026-11-20-sidebar-areas-sound-design.md`

## Global Constraints

- Every new `/api` route requires the page token like the existing ones (it sits after the token check in `src/server/http.ts`).
- Order bodies are `string[]`; anything else → 400. Unknown ids ignored; items missing from the list keep their relative order after the listed ones.
- Sound files: mp3, wav or ogg, recognised by magic bytes (not by name or header), at most `1 * 1024 * 1024` bytes, stored under `<dataDir>/sounds/` with server-made names (`<uuid>.<ext>`); a sound is only ever referred to by that id.
- Event urgency: `blocked` > `finished` > `maybe-waiting` (the existing `Reason` values).
- No sound plays while `document.hasFocus()` is true.
- Per-browser UI memory (folded sidebar/sections) uses localStorage wrapped in try/catch, like `readCollapsed` in `Sidebar.tsx`.
- Drag data types: `application/x-shellyard-session` (existing), `application/x-shellyard-area`, `application/x-shellyard-launcher`; a drop target only reacts to its own types.
- All texts in English. Icons are inline SVG, 16 px, `currentColor`; no new dependency.
- Run vitest from `C:/repos/...`, not `/c/repos/...`.

## Review Focus

1. **A reorder arriving with stale ids** (an area deleted meanwhile) must not drop or duplicate stories (Task 1 test `ignores unknown ids and keeps missing ones`).
2. **Deleting a sound in use** must reset every event setting and area that pointed to it (Task 2 test `deleting a sound clears the settings and areas that used it`).
3. **A file renamed to .mp3 that is not audio** must be refused (Task 2 test `refuses bytes that are not mp3, wav or ogg`).
4. **Dragging a session onto a session of another area** must move it there and place it (Task 5 manual check + Task 3 `moveInOrder` tests).
5. **Several sessions starting to wait at once** play one sound only (Task 3 test `plays one sound for several waiting sessions`).

---

### Task 1: Server — orders of areas, sessions and launchers

**Files:** Modify `src/server/stories.ts`, `src/server/session-manager.ts`, `src/server/config.ts`, `src/server/http.ts`, `src/shared/types.ts` (if needed). Test: `tests/server/stories.test.ts`, `tests/server/session-manager.test.ts`, `tests/server/http.test.ts`, `tests/server/config.test.ts`.

**Interfaces — Produces:**
```ts
// shared helper (server): src/server/order.ts (new)
export function applyOrder<T>(items: T[], ids: string[], idOf: (t: T) => string): T[]
StoryStore.reorder(ids: string[]): Story[]          // saves, emits change
SessionManager.reorder(ids: string[]): void         // reorders entries, emits change
// Config gains: profileOrder: string[]  (default [])
// SessionManager.profiles() sorted by config().profileOrder via applyOrder
PUT /api/stories/order   body string[] → Story[]
PUT /api/sessions/order  body string[] → SessionInfo[]
PUT /api/profiles/order  body string[] → Profile[]
```
- [ ] Step 1: failing tests — `applyOrder` (`orders by ids`, `ignores unknown ids and keeps missing ones`, `ignores duplicates`); `StoryStore.reorder` saves and emits; `SessionManager.reorder` changes `list()` order and emits; `restorable()` follows the new order; `profiles()` follows `profileOrder`; config load keeps a valid `profileOrder` and drops non-strings; each route: 400 on non-array / non-string items, 401 without token, 200 with the new order.
- [ ] Step 2: run — FAIL. Step 3: implement. Step 4: `npm test`, `npm run typecheck` — PASS.
- [ ] Step 5: commit `"Order of areas, sessions and launchers on the server"`.

### Task 2: Server — sound library and settings

**Files:** Create `src/server/sounds.ts`. Modify `src/server/config.ts`, `src/server/stories.ts`, `src/server/http.ts`, `src/shared/types.ts`. Test: `tests/server/sounds.test.ts`, `tests/server/http.test.ts`, `tests/server/stories.test.ts`.

**Interfaces — Produces:**
```ts
// types.ts
export interface SoundFile { id: string; name: string }          // id = '<uuid>.<ext>'
export interface SoundSettings { blocked: string | null; finished: string | null; maybeWaiting: string | null }
export interface SoundLibrary { sounds: SoundFile[]; settings: SoundSettings }
// Story gains: sound: string   ('' = none). StoryInput gains sound?: string (must be '' or an existing id; else '')
// sounds.ts
export const MAX_SOUND_BYTES = 1024 * 1024
export function soundKind(bytes: Buffer): { ext: 'mp3' | 'wav' | 'ogg'; type: string } | null
//   mp3: 'ID3' or 0xFF 0xE0-mask frame sync; wav: 'RIFF'....'WAVE'; ogg: 'OggS'
export class SoundStore { list(): SoundFile[]; add(bytes: Buffer, name: string): SoundFile | null; read(id): {bytes, type} | null; remove(id): boolean; settings(): SoundSettings; setSettings(s: unknown): SoundSettings }
//   labels kept in config `soundFiles: SoundFile[]`; settings in config `sounds: SoundSettings`
//   remove() also nulls settings using it and sets story.sound = '' for areas using it
GET    /api/sounds            → SoundLibrary
POST   /api/sounds?name=<label>  raw body → SoundFile (201); 400 not audio; 413 too big
GET    /api/sounds/:id        → the file, with its content type
DELETE /api/sounds/:id        → 204; 404 unknown
PUT    /api/sounds/settings   body SoundSettings → SoundSettings (unknown ids → null)
```
- [ ] Step 1: failing tests — `soundKind` for the three formats and a PNG/text (null); `refuses bytes that are not mp3, wav or ogg`; size limit 413; label trimmed to 80 chars, default `sound`; `deleting a sound clears the settings and areas that used it`; settings with an unknown id become null; story `sound` normalised; routes need the token; `GET /api/sounds/:id` rejects ids not matching `^[0-9a-f-]{36}\.(mp3|wav|ogg)$`.
- [ ] Step 2: FAIL. Step 3: implement (reuse the raw-body reading used by `/api/backgrounds`). Step 4: `npm test`, typecheck — PASS.
- [ ] Step 5: commit `"Sound library and sound settings on the server"`.

### Task 3: Page — order helper, board order, sound choice and player

**Files:** Create `src/web/order.ts`, `src/web/sounds.ts`. Modify `src/web/board.ts`, `src/web/api.ts`, `src/web/main.tsx`, `src/web/sound.ts`, `src/web/store.ts`. Test: `tests/web/order.test.ts`, `tests/web/sounds.test.ts`, `tests/web/board.test.ts`.

**Interfaces — Produces:**
```ts
// order.ts
export type Place = 'before' | 'after'
export function moveInOrder(ids: string[], dragged: string, target: string, place: Place): string[]
export function placeFor(offsetY: number, height: number): Place     // top half → before
// api.ts
reorderStories(ids): Promise<Story[]>; reorderSessions(ids): Promise<SessionInfo[]>; reorderProfiles(ids): Promise<Profile[]>
sounds(): Promise<SoundLibrary>; addSound(file: File): Promise<SoundFile>; deleteSound(id): Promise<void>; saveSoundSettings(s): Promise<SoundSettings>
// sounds.ts
export type SoundEvent = 'blocked' | 'finished' | 'maybeWaiting'
export function eventOf(s: SessionInfo): SoundEvent           // reason null → maybeWaiting
export function pickSound(waiting: SessionInfo[], stories: Story[], settings: SoundSettings): string | null | undefined
//   undefined: nothing waiting; null: the chime; string: a sound id
export function shouldPlay(hasFocus: boolean, soundOn: boolean): boolean
export function playSound(id: string | null): Promise<void>   // object URL cache via token fetch; any failure → chime()
// store: soundLibrary: SoundLibrary loaded at start (api.sounds) and refreshed after changes: refreshSounds()
```
- [ ] Step 1: failing tests — `moveInOrder` (before/after, same item no-op, dragged not in list appended at target, target missing → unchanged); `placeFor`; `boardAreas keeps the story order even when a later area is waiting`, "No area" last; `eventOf`; `pickSound`: urgency order, `area sound overrides the event sound`, area '' uses event, `plays one sound for several waiting sessions`; `shouldPlay(true, true) === false`.
- [ ] Step 2: FAIL. Step 3: implement; in `main.tsx` replace `if (waiting.length > 0 && getState().sound) chime()` with `shouldPlay(document.hasFocus(), sound)` + `playSound(pickSound(...))`. Step 4: `npm test`, typecheck, build — PASS.
- [ ] Step 5: commit `"Order helper, board keeps the area order, sound per event and area"`.

### Task 4: Sidebar — icons, foldable sidebar and sections

**Files:** Create `src/web/components/icons.tsx`. Modify `src/web/components/Sidebar.tsx`, `src/web/App.tsx` (if the layout needs the folded width), `src/web/theme.css`. Test: `tests/web/sidebar-memory.test.ts` for the localStorage helpers (moved to `src/web/sidebar-memory.ts`).

**Interfaces — Produces:** icons `BoardIcon, AttentionIcon, TerminalsIcon, ConversationsIcon, SchedulesIcon, UsageIcon, NewSessionIcon, NewAreaIcon, SidebarIcon` (props `{ size?: number }`); `src/web/sidebar-memory.ts`: `readFlag(key): boolean`, `writeFlag(key, value)`, keys `shellyard-sidebar-folded`, `shellyard-sessions-folded`, `shellyard-launchers-folded`.
- [ ] Step 1: failing tests for `readFlag`/`writeFlag` (default false, survives a throwing localStorage).
- [ ] Step 2: implement. Each nav entry: icon + label. A toggle button (SidebarIcon, `aria-expanded`, title "Fold the sidebar"/"Unfold the sidebar") at the top. Folded: `aside.sidebar.folded` ~52 px wide, shows the toggle, nav icons with `title` = label and counts as small badges, the New session button as an icon; hides brand text, New area, Sessions, Launchers, powered-by. "Sessions" and "Launchers" `h2` become buttons with ▾/▸ and `aria-expanded`; folding hides their content (and the add-launcher button).
- [ ] Step 3: `npm test`, typecheck, build — PASS.
- [ ] Step 4: commit `"Sidebar icons, foldable sidebar, Sessions and Launchers sections"`.

### Task 5: Drag and drop — areas, sessions, launchers (sidebar and board)

**Files:** Create `src/web/drag.ts`. Modify `src/web/components/Sidebar.tsx`, `src/web/components/BoardView.tsx`, `src/web/theme.css`.

**Interfaces — Consumes:** Task 3 `moveInOrder`, `placeFor`, `api.reorder*`, `api.moveSession`. **Produces:** `drag.ts`: `SESSION_DRAG`, `AREA_DRAG`, `LAUNCHER_DRAG` constants (BoardView's local `DRAG_TYPE` replaced by `SESSION_DRAG`).
- [ ] Step 1: Sidebar — area headers draggable (`AREA_DRAG`), drop on another area header → `moveInOrder` + `api.reorderStories`, indicator class `drop-before`/`drop-after`; "No area" header not draggable and not an area-drop target. Session rows draggable (`SESSION_DRAG`); drop on a session row → if other area `api.moveSession` then `api.reorderSessions(moveInOrder(allSessionIds, …))`; drop on an area header or list → `api.moveSession(id, storyId)` (skip if same area). Launcher rows draggable (`LAUNCHER_DRAG`) → `api.reorderProfiles` then `refreshMeta()`.
- [ ] Step 2: Board — area cards draggable by their header (`AREA_DRAG`) with the same before/after rule (left/right half is fine for a wrapping grid: use `placeFor` on the X axis); session dots: drop on a dot places before/after it as in the sidebar. Existing drop-on-area behaviour kept.
- [ ] Step 3: Optimistic update: apply the new order in the store immediately; on error alert and let the next server update restore it.
- [ ] Step 4: typecheck, `npm test`, build — PASS.
- [ ] Step 5: commit `"Drag to reorder areas, sessions and launchers on the board and in the sidebar"`.

### Task 6: Sound settings UI and README

**Files:** Create `src/web/components/SoundsDialog.tsx`. Modify `src/web/components/Cluster.tsx` (a "Sounds…" button next to the Sound checkbox), `src/web/components/StoryDialog.tsx` (Sound select), `src/web/theme.css`, `README.md`.
- [ ] Step 1: SoundsDialog (portal, `useEscape` from `src/web/escape.ts`): three rows "Needs permission" (blocked), "Finished", "Maybe waiting" — select `Chime` + each added sound, "Play" button → `playSound`; list of added sounds with Play and Delete (confirm `Delete the sound "<name>"? Settings and areas using it go back to the defaults.`); "Add sound…" file input (`accept="audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg"`), errors shown in `.error`. Saves with `api.saveSoundSettings`, then `refreshSounds()`.
- [ ] Step 2: StoryDialog: "Sound" select — `Event sounds` (value '', the default) and each added sound (value = its id); a Play button next to it when a sound is chosen. The chime is not offered as an area override ('' already falls back to the event sounds).
- [ ] Step 3: README: short sections on reordering by drag, folding the sidebar, and sounds (per event, per area, silent while focused).
- [ ] Step 4: typecheck, `npm test`, build — PASS.
- [ ] Step 5: commit `"Sounds dialog, area sound, README"`.
