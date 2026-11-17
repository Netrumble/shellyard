# Console View Manager — Stage 3 (Usage and Visual Character) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how much of the Claude plan limits is used and what sessions cost, per model and per story, and give the whole UI the sports-car instrument-cluster character described in the spec.

**Architecture:** Claude Code itself reports usage: every session CVM starts gets a status-line command (through the same per-session settings file as the hooks) that forwards Claude Code's status payload to the server. The payload carries the plan-limit percentages, the session's cumulative estimated cost, its token totals and its current model. A `UsageStore` turns cumulative figures into per-day amounts attributed to a model and a story, persists them, and the server pushes a summary to clients. The server also publishes how much each terminal is printing per second, which drives the per-session rev counters. The client renders SVG dials and the other effects, all governed by one effects setting.

**Tech Stack:** unchanged; dials and effects are hand-written SVG and CSS, no chart library.

**Spec:** `docs/superpowers/specs/2026-11-17-console-view-manager-design.md`, sections "Usage" and "Visual character". Where this plan differs from "Usage" it is because of the Findings below; the spec text is updated in Task 5.

## Findings (verified 2026-11-17, Claude Code 2.1.326, subscription account)

- A `statusLine` command passed through `--settings <file>` takes effect, and its stdin is a JSON payload.
- The payload contains `rate_limits.five_hour` and `rate_limits.seven_day`, each `{ used_percentage, resets_at }` (`resets_at` in epoch seconds); `cost.total_cost_usd` (cumulative for the session, Claude Code's own estimate); `context_window.total_input_tokens` and `total_output_tokens` (cumulative; input includes cache reads and writes); `model.id` and `model.display_name` (the model in use now, so it follows `/model`); `session_id`.
- The status line ran 3 times for one short prompt.
- The user has no status line of their own; CVM must still pass one through if present.

Consequences, decided here:
- **No transcript parsing and no price table.** The cost shown is Claude Code's own figure, which is more accurate than tokens multiplied by a list CVM would have to maintain. The price for this: usage is known only for sessions started from CVM, from the moment stage 3 is installed. The spec's "all Claude Code use on the machine" is given up.
- **No budget fallback.** The limit data exists. When it is absent (an API-key account has no plan limits) the limit dials show "no data".
- **The model on a session card follows the session**, fixing the stage 1 limit "the model shown is the launch value".

## Global Constraints

- All constraints of stages 1 and 2 hold (Node >= 22, loopback only, token auth with no cookie, never modify the user's Claude settings, English in the repository, no git operations unless the user asks).
- Never present an estimate as exact: costs are labelled "est."; a dial with no data shows "no data", never zero.
- Every dial shows its value as text too; nothing is conveyed by motion or colour alone.
- No effect is drawn over a terminal or delays interaction with one.
- Effects setting: `full`, `reduced`, `off`. With no saved choice, `prefers-reduced-motion: reduce` selects `reduced`. `reduced` keeps colours and values and removes sweeps, pulses and rolling digits; `off` also removes rev counters, lamps' pulsing and decorative elements.
- Sound is off unless the user turns it on.
- Generic sports-car styling only: no car maker's name, logo or badge anywhere.
- Animations use CSS transforms and SVG only.
- The status-line forwarder must never disturb a Claude session: exit 0 always, nothing on stderr, and print exactly what the user's own status line prints (or nothing).

## Review Focus

1. **A status payload with fields missing, of the wrong type, or with a cumulative cost lower than the last one seen** (session compacted, resumed, or a different Claude Code version): no crash, no negative amounts; unknown parts are ignored. Test in Task 1.
2. **A session that runs across midnight**: the cost accrued after midnight goes to the new day. Test in Task 1.
3. **A limit reading that is old** (no Claude session active for hours): the dial shows its age, and a reading whose reset time has passed is not shown as current. Test in Task 2.
4. **`usage.json` missing, corrupt, or written by a future version**: the server starts and counts from now; a corrupt file is kept aside, not silently replaced. Test in Task 1.
5. **Ten sessions printing at once with effects on `full`**: typing in a terminal stays responsive. Checked in Task 4 by measurement, not by eye.

---

### Task 1: Usage on the server

**Files:** Create `src/hook/statusline.ts`, `src/server/usage.ts`, `src/server/activity.ts`; Modify `src/shared/types.ts`, `src/server/claude-launch.ts`, `session-manager.ts`, `http.ts`, `ws.ts`, `index.ts`, `config.ts`; Tests `tests/server/usage.test.ts`, `tests/server/activity.test.ts`, `tests/hook/statusline.test.ts`, plus additions to `claude-launch.test.ts`, `session-manager.test.ts`, `http.test.ts`, `ws.test.ts`

**Interfaces:**
- `types.ts`:

```ts
export interface LimitReading { usedPercentage: number; resetsAt: number }   // resetsAt in ms
export interface UsageLine { key: string; label: string; tokensIn: number; tokensOut: number; costUsd: number }
export interface UsagePeriod { costUsd: number; byModel: UsageLine[]; byStory: UsageLine[] }
export interface UsageSummary {
  limits: { fiveHour: LimitReading | null; sevenDay: LimitReading | null; readAt: number | null };
  today: UsagePeriod; week: UsagePeriod; month: UsagePeriod;   // today, last 7 days, last 30 days, each including today
}
// ServerMessage gains { t: 'usage'; usage: UsageSummary } and { t: 'activity'; rates: Record<string, number> }
```
- `usage.ts`:

```ts
export interface StatusPayload { /* parsed, validated subset */ modelId: string | null; modelName: string | null; costUsd: number | null; tokensIn: number | null; tokensOut: number | null; fiveHour: LimitReading | null; sevenDay: LimitReading | null }
export function parseStatusPayload(body: unknown): StatusPayload | null;       // null if not an object
export class UsageStore {
  constructor(deps: { now: () => number; file: string });
  record(sessionId: string, p: StatusPayload, ctx: { storyId: string | null; storyName: string | null }): void;
  summary(): UsageSummary;
  onChange(cb: () => void): void;
  flush(): void;                                                               // writes the file now
}
```
  Cumulative figures become deltas per session (a lower figure than last time restarts the baseline, adding nothing); a delta goes to the local-time day it arrives in, under the model in use and the session's story at that moment. Sessions with no story are listed under the label `No story`. The file is `<dataDir>/usage.json`, written atomically at most every 5 s and on stop; days older than 90 are dropped.
- `activity.ts`: `class ActivityMeter { constructor(now); add(id, bytes); rates(): Record<string, number>; forget(id) }` — bytes printed in the last 1000 ms per session; sessions at zero are omitted.
- `claude-launch.ts`: the settings file gains `statusLine: { type: 'command', command: '"<node>" "<statusline.js>"' }`; `ClaudeLaunchInput.statusScriptPath`.
- `statusline.ts`: POSTs stdin to `/api/status/<sessionId>` with the hook token (2 s timeout), then, if `~/.claude/settings.json` has `statusLine.command`, runs it with the same stdin and prints its stdout; always exits 0.
- `session-manager.ts`: `setModel(id, name)` updates `SessionInfo.model` when it differs; `ManagerDeps.statusScriptPath`.
- `http.ts`: `POST /api/status/:id` (hook token; 204; 400 bad body; 404 unknown session) → `usage.record`, `manager.setModel`. `GET /api/usage` → `UsageSummary`.
- `ws.ts`: sends `usage` on connect and at most once per second after changes; sends `activity` once per second while any rate is non-zero, and one final empty message when all return to zero.

- [ ] **Step 1: Write the failing tests** for every interface line and for Review Focus 1, 2 and 4.
- [ ] **Step 2: Run** `npx vitest run` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and the type check — Expected: PASS, clean.
- [ ] **Step 5: Real check:** start a real Claude session through CVM, send one prompt, and read `GET /api/usage`: limits present, today's cost above zero, one model line, the session card's model matching Claude's.

---

### Task 2: Gauge mathematics and effect rules (pure, tested)

**Files:** Create `src/web/gauges.ts`, `src/web/effects.ts`; Tests `tests/web/gauges.test.ts`, `tests/web/effects.test.ts`

**Interfaces:**

```ts
// gauges.ts
export function needleAngle(value: number, max: number): number;        // -120° at 0 to +120° at max, clamped; NaN or max<=0 → -120
export function zoneOf(pct: number): 'ok' | 'warn' | 'danger';          // < 70, 70..89.999, >= 90
export function shiftLights(pct: number, count?: number): Array<'off' | 'green' | 'amber' | 'red'>;   // 10 lights; lit proportionally; first 5 green, next 3 amber, last 2 red
export function limitDisplay(r: LimitReading | null, readAt: number | null, now: number): { state: 'no-data' | 'expired' | 'ok'; pct: number; resetsIn: string; age: string };
export function revLevel(bytesPerSecond: number): number;                // 0..1, logarithmic: 0 → 0, 20 B/s → ~0.25, 20 kB/s → 1
export function odometerDigits(text: string): string[];                  // one entry per character, for rolling columns
export function formatUsd(v: number): string;                            // '$0.00', '$14.20', '$1,204'
export function formatTokens(v: number): string;                         // '0', '950', '12.3k', '1.2M'
export function durationLabel(ms: number): string;                       // '1h 12m', '3d 4h', '45s', 'now'
// effects.ts
export type EffectsLevel = 'full' | 'reduced' | 'off';
export function resolveEffects(saved: string | null, prefersReducedMotion: boolean): EffectsLevel;
export function lampState(s: SessionInfo): 'off' | 'working' | 'blocked' | 'finished' | 'exited';
```

- [ ] **Step 1: Write the failing tests**, including Review Focus 3 (`limitDisplay` with a reading whose `resetsAt` has passed is `expired`; with `readAt` 3 hours ago `age` is `3h 0m ago`; `null` is `no-data`).
- [ ] **Step 2: Run** `npx vitest run tests/web` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.

---

### Task 3: The instrument cluster

**Files:** Create `src/web/components/Dial.tsx`, `Tachometer.tsx`, `Cluster.tsx` (header: shift lights, warning lamps, mini dials), `UsageView.tsx`, `Odometer.tsx`, `EffectsMenu.tsx`, `src/web/sound.ts`; Modify `src/web/store.ts`, `socket.ts`, `App.tsx`, `components/Sidebar.tsx`, `SessionBits.tsx`, `AttentionPanel.tsx`, `TerminalsGrid.tsx`, `theme.css`

Behaviour, from the spec's "Visual character" and "Usage view":
- **Theme:** dark panel, one accent red, amber for warnings, fine dial markings; colours stay CSS variables.
- **Usage view** (new navigation entry): two large dials for the 5-hour and weekly limits with reset countdown and age of the reading; one dial for today's estimated cost; a period switch (today / 7 days / 30 days); a table per model (tokens in, tokens out, est. cost) and per story (est. cost). Every figure labelled "est." where it is one. Empty state when nothing has been recorded.
- **Header cluster**, on every view: the two limit dials small, turning amber then red by zone; shift lights for the 5-hour limit, blinking above 90% (not in `reduced`/`off`); one warning lamp per session (off idle, steady green working, pulsing amber blocked or possibly waiting, chequered pattern finished, dim red exited), each with an accessible name and a click that opens the session.
- **Rev counter** beside each session in the sidebar and on tile and card headers, driven by `activity`.
- **Needles** move with spring-like easing and slight overshoot; **odometer** digits roll on change.
- **Ignition:** on first render every dial sweeps to full scale and back in under one second, without blocking input.
- **Start button:** "New session" becomes a round engine-start button.
- **Chequered flag:** sweeps once across a card when its session enters `finished`.
- **All clear:** a brief flourish when the last waiting session is handled.
- **Effects menu** in the header: full / reduced / off, and a sound toggle (soft chime on entering attention, off by default).

- [ ] **Step 1: Implement** the components and wire the store to the `usage` and `activity` messages.
- [ ] **Step 2: Run** `npx vitest run`, type check, `npm run build` — Expected: PASS, clean.
- [ ] **Step 3: Browser check** (headless Edge, screenshots read back): Usage view with data and without; header cluster with sessions in each lamp state; limit at 30%, 75% and 95%; the three effects levels; narrow window with no horizontal overflow; keyboard focus visible on lamps and menu.

---

### Task 4: Regression, performance, packaging

- [ ] **Step 1:** Full suite on Windows and Linux.
- [ ] **Step 2:** Performance (Review Focus 5): ten sessions each printing continuously, effects `full`; measure in the page the delay between a keystroke sent to a terminal and its echo appearing, and the frame rate; compare with effects `off`. Record the numbers. If typing delay with `full` exceeds `off` by more than 50 ms at the median, reduce the effects until it does not.
- [ ] **Step 3:** Real Claude Code through the UI: limits and cost appear on the dials; the user's Claude settings file is untouched.
- [ ] **Step 4:** Pack; install the tarball in a clean prefix on Windows and Linux; start; stop.

### Task 5: Documents

- [ ] Update `README.md` (usage, what the figures mean and their limits, effects setting) and the spec's "Usage" section to match what was built.
