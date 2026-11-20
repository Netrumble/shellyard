# Sidebar, area order and sound — design

Date: 2026-11-20 · Status: proposed

## Intent

Make the sidebar and the board easier to organise and quieter when it should be: one order of
areas the user controls from both places, sessions moved between areas by dragging in the
sidebar too, a sidebar that can be folded away, and a notification sound that stays silent
while the user is looking at ShellYard and can be replaced with one of their own.

## Decided with the user

1. **One order of areas**, shared by the board and the sidebar. Areas can be dragged on the
   board and in the sidebar; a move in either place changes both. The board no longer lifts
   areas with a waiting session to the top: areas stay where the user put them (they still
   light up). "No area" is always last and cannot be dragged.
2. **Sessions dragged between areas in the sidebar**, as already on the board (onto an area,
   or onto "No area" to take a session out).
3. **Icons** on the sidebar's menu entries.
4. **The sidebar can be folded.**
5. **The Launchers section can be folded.**
6. **The Sessions section can be folded.**
7. **No chime while ShellYard has the focus.**
8. **A custom sound**, the current chime staying the default.

9. **Sessions can be reordered inside an area**, and **launchers can be reordered**, by
   dragging, on the board and in the sidebar alike (one order each, shared).
10. **Sounds per event, with an override per area** (the user's choice among three options):
    a sound for each of the three events — *blocked* (Claude asks for permission),
    *finished*, *maybe waiting* (silent for a while) — and an area may have its own sound,
    which replaces the event sounds for that area's sessions. Each sound is either the
    built-in chime (the default) or a sound file the user added. This replaces point 8's
    single custom sound.

## Non-goals

- A sound per area *and* per event (an area × event table): option 2, not chosen.
- Moving a session to another area by dropping it between two sessions of that area at a
  precise place is fine, but no cross-view drag (e.g. from the Terminals grid) is added.
- Any change to system notifications (they already stay quiet while the page has the focus).

## Approaches

One sensible way for each point, building on what exists:

- Area order: keep it as the order of `stories` in the config (it already is the source of
  the order) and add a reorder route. Alternatives — an `order` number per story, or an order
  kept per browser — were dropped: the first adds renumbering for nothing, the second would not
  be shared between the board and the desktop app.
- Custom sound: stored by the server, like uploaded backgrounds (`backgrounds.ts`), so the
  browser and the desktop app share it. Keeping it in browser storage was dropped: it would
  not reach the desktop app, and audio files are large for it.
- Icons: inline SVG components drawn for ShellYard, like the existing VS Code mark; no icon
  library is added.

## Design

### Area order (server)

- `StoryStore.reorder(ids: string[]): Story[]` — puts the stories in the order of `ids`; ids
  that are not stories are ignored, stories missing from `ids` keep their relative order after
  the listed ones. Saved like other story changes and announced through the same change event,
  so every open page updates.
- `PUT /api/stories/order` with body `string[]` → the reordered `Story[]`; 400 if the body is
  not an array of strings. Page token required, as for every `/api` route.

### Area order (page)

- `boardAreas` keeps the story order (the waiting-first sort is removed); "No area" last.
- A pure helper `moveInOrder(ids, dragged, target, place: 'before' | 'after')` computes the
  new order; the page sends it with `api.reorderStories(ids)` and applies it at once
  (optimistically), then takes the server's answer.
- Dragging: an area is dragged by its header (board card header, sidebar area header). While
  dragging over another area's header, a line shows where it will land (before when the
  pointer is in the top half, after otherwise). Area drags and session drags use different
  data types, so dropping one never triggers the other.

### Sessions dragged in the sidebar

- Session rows in the sidebar are draggable with the same data type the board uses; dropping
  on an area header or its list calls `api.moveSession(id, storyId)`; dropping on "No area"
  moves it out (`null`). A drop on the session's own area does nothing.

### Icons

- `src/web/components/icons.tsx`: small SVG icons (16 px, `currentColor`) for Board, Needs
  attention, Terminals, Conversations, Schedules, Usage, New session, New area, and the fold
  toggle. Each nav entry shows icon + text.

### Folding

- **Sidebar**: a toggle at the top. Folded, the sidebar becomes a narrow rail with the nav
  icons (counts shown as small badges, names as tooltips) and the New session button as an
  icon; sessions and launchers are hidden.
- **Sessions** and **Launchers** section titles become fold toggles (▾/▸).
- All three are remembered per browser (localStorage, guarded like the existing folded-area
  memory), not on the server.

### Session order

- The order of sessions is the manager's own order (the order of `list()`), which the
  sidebar and board already follow inside each area, and which the restore file already
  keeps across restarts.
- `SessionManager.reorder(ids: string[])`: same rules as `StoryStore.reorder`; announces a
  change. `PUT /api/sessions/order` with `string[]`.
- Dragging a session onto another session row/card places it before or after it (top/bottom
  half). If that session is in another area, the dragged one also moves to that area
  (`moveSession`, then reorder). Dropping on an area header or empty list keeps today's
  behaviour (move to that area, at its end).

### Launcher order

- Config gains `profileOrder: string[]` (absent: today's order — the user's own, then the
  built-ins). `SessionManager.profiles()` sorts by it; ids not in it keep their place after
  the listed ones.
- `PUT /api/profiles/order` with `string[]` saves it. Launcher rows in the sidebar are
  draggable (before/after, as for areas). Launchers are not shown on the board.

### Sound

- **Focus**: no sound at all while `document.hasFocus()` is true (main.tsx).
- **Sound library** (server, stored like backgrounds under the data folder `sounds/`):
  `POST /api/sounds` (raw body, mp3/wav/ogg checked by content type and magic bytes, at most
  1 MB, the original file name kept as label) → `{ id, name }`; `GET /api/sounds` → list;
  `GET /api/sounds/:id` serves the file (token); `DELETE /api/sounds/:id` removes it and
  clears every setting that used it.
- **Choices**: config gains `sounds: { blocked: string | null; finished: string | null;
  maybeWaiting: string | null }` (null: the chime), set with `PUT /api/sounds/settings`.
  `Story` gains `sound: string` ('' = none: use the event sounds), edited in the area dialog.
- **Which sound plays**: when sessions start waiting in one update, one sound plays:
  the most urgent event among them (blocked > finished > maybe waiting) decides the event;
  if that session's area has a sound, the area's sound plays, otherwise the event's. A pure
  function `pickSound(waiting, stories, settings)` decides it. A sound file that cannot load
  or play falls back to the chime.
- **Where it is set**: next to the existing Sound checkbox a "Sounds…" button opens a dialog:
  one row per event (select: Chime / each added sound; "Play" to try), the list of added
  sounds (add, play, delete). The area dialog gets a "Sound" select (Event sounds / added
  sounds) with "Play".
- Page: each sound file is fetched once with the token into an object URL (like
  `backgroundUrl`) and played with an `Audio` element.

### Tests

- `StoryStore.reorder`, `SessionManager.reorder`, profile order (unknown/missing ids), the
  three order routes (validation, token, change event), `moveInOrder`, `boardAreas` keeping
  the story order, the sound routes (type, magic bytes, size, token, delete clears settings
  and areas), `pickSound` (urgency, area override, missing file), and the focus rule.

## Left to the builder

- Exact icon drawings, rail width and CSS, within the existing look and both themes.
- Whether the drop indicator is a line or a highlighted gap.
