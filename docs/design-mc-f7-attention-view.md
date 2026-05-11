# F-7 — Attention drill-down view (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f7-attention-view.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §5 (Agent attention view) and §5.4 (Borrowing from miner).
**Date:** 2026-04-23.
**Status:** Decided. Resolves the open questions enumerated below before F-7 implementation begins.

## Why this addendum

§5 specifies the attention drill-down's shape — three vertical sections (summary, event log, input affordance), D/A/H colour classification borrowed from miner, virtualised time-descending log, streamed assistant text — but several decisions were deferred to implementation time or are conditional on Phase A verification outcomes. Before code lands, we resolve the ones that meaningfully shape the F-7 PR and call out the ones that are explicitly NOT in scope for F-7 so the PR checkbox stays honest.

F-6 used this same discipline (`docs/design-mc-f6-focus-area.md`). Keeping it consistent.

## Decision 1 — Input affordance (section ③) is a disabled placeholder, not omitted

§9 Phase B ships "Attention view (§5) rendering against the event log." Phase C (F-10) ships the input affordance. F-7 therefore renders section ③ as a **disabled placeholder** showing the three-section layout intact:

```
┌──────────────────────────────────────────┐
│ [text box — disabled]                    │
│ Operator input ships in F-10 (Phase C)   │
└──────────────────────────────────────────┘
```

**Why not omit?** The three-section layout is the operator's spatial mental model; shipping two sections and re-adding the third in F-10 would be a restructure, not a wire-up. A visible placeholder preserves the layout and signals the imminent capability.

**Exception:** the Approve / Deny affordance on `permission.request` rows (§5.3.1) also stays visual-only in F-7 — see Decision 6.

## Decision 2 — Drill-down is an overlay, not a route

**Implementation:** a foreground panel overlaying the main content column, triggered by Enter / click from the focus area (F-6 deferred Enter/Esc to F-7). Focus-area cards and the working-agent grid remain visible underneath as context, matching §5.5 "other cards remain visible as context".

- **Open:** `Enter` on selected focus card, or click on any card.
- **Close:** `Esc` returns to focus-area root; clicking outside the overlay also closes.
- **URL:** drill-down state does NOT change `location.hash` in F-7. If deep-linking is needed later, add `#/a/:assignmentId` as an additive concern — not a blocker for F-7.

**Why not route-driven?** A router refactor isn't justified by F-7 alone. The dashboard is a single inline HTML file with no build step; introducing a router is a Phase C / F-10 concern at earliest when operator actions produce meaningful URL-shareable state.

## Decision 3 — New endpoint: `GET /api/assignments/:id/events`

F-7 needs past events for initial paint; WS only carries live events from connection time forward. Adding one endpoint:

```
GET /api/assignments/:id/events?before=<eventId>&limit=50

200 { events: EventRow[], hasMore: boolean }
404 { error: "No such assignment" }
```

**Shape:**
- Events scoped to the *currently-active session* for the assignment (the one that `resolveSessionEndpoint` would return). If no session exists yet, return `{ events: [], hasMore: false }`.
- Ordered **ascending by `seq`** (the existing events table column). The renderer handles time-descending presentation — keep the API order aligned with table order for predictable pagination.
- `before` is exclusive; if omitted, return the newest `limit` events. If provided, return up to `limit` events with `seq < before.seq`.
- `limit` clamped at 200.

**WS merge:** live `event` frames arriving with `sessionId` matching the open drill-down are appended to the top of the rendered log. The existing `broadcastEvent` in `notifications.ts` already scopes by `sessionId` — F-7 filters client-side.

**Why not assignment_id directly?** The `events` table is keyed by `session_id`; a single assignment may have had multiple sessions across dispatch cycles. F-7 shows the current session's events. Multi-session history view is deferred (§5.2 dispatch cycle — see Decision 7).

## Decision 4 — D/A/H classification happens at content-block granularity, not event-type granularity

Concrete event types in the system today (verified in `src/mission-control/session/stdout-dispatcher.ts:120` and `src/mission-control/db/events.ts`):

| Event type | Source | What it contains |
|---|---|---|
| `stream-json.system` | CC init | Session metadata |
| `stream-json.assistant` | CC turn | `message.content[]` — blocks of `{type: "text"}`, `{type: "thinking"}`, `{type: "tool_use"}` |
| `stream-json.user` | CC turn | `message.content[]` — blocks of `{type: "text"}` or `{type: "tool_result"}` |
| `stream-json.result` | CC terminal | `subtype`, `result`, cost/token stats |
| `stream-json.unknown` | fallback | unrecognised CC type |
| `state.transition` | state machine | `from`, `to`, `block_reason` |
| `operator.input` | REST | `text` |
| `permission.request` | state machine (F-2 helper, not yet emitted by dispatcher) | `requested_action`, `target`, `context`, `risk_hint` |
| `system.error` | Grove internals | `message` |

**A single `stream-json.assistant` event may contain mixed content blocks** — e.g., a thinking block, some text, then a `tool_use`. §5.3's three-weight table assumes per-row classification. F-7 therefore **expands `stream-json.assistant` and `stream-json.user` into one rendered row per content block at render time** (no schema change).

**D/A/H map applied per rendered row:**

| Colour | Classification | Rendered from |
|---|---|---|
| **D — green (deterministic)** | Tool calls and their results | `tool_use` + `tool_result` content blocks; `state.transition`; `system.error` |
| **A — amber (agentic)** | Agent reasoning / output | `text` blocks inside `stream-json.assistant`; `thinking` blocks (rendered inline per Maestro pattern); `stream-json.system` as tertiary chip |
| **H — rose (human)** | Operator actions / prompts to the operator | `operator.input`; `permission.request`; `text` blocks inside `stream-json.user` when the `user` event is operator-sourced (distinguishable by flag on the event — **see Decision 5**) |
| *(no colour)* | `stream-json.unknown`, `stream-json.result` | Rendered as thin tertiary chip only |

**Visual-weight mapping** (from §5.3 table, resolved against our types):

- **Primary:** `text` in `stream-json.assistant`, `operator.input`, `permission.request`, `state.transition` where `to = 'blocked'`.
- **Secondary:** `tool_use`, `tool_result` — compact left-border accent row, collapsed by default.
- **Tertiary:** `thinking` blocks, `stream-json.system`, `state.transition` (non-blocking), `system.error`, `stream-json.unknown`, `stream-json.result`.

Permission-request rows are always primary even when their parent event would otherwise be secondary — §5.3 explicit rule.

## Decision 5 — Operator-sourced `user` events are distinguishable by an explicit marker

CC emits `stream-json.user` for both operator input turns (what the operator typed) AND tool-result callbacks (what tools returned). Classifying these as H or D requires disambiguation.

**Marker:** `operator.input` events emitted by `POST /api/assignments/:id/input` in `api/handlers.ts:270` already write a separate event type. The corresponding `stream-json.user` event that CC echoes back is classifiable by content: if `message.content[0].type === "tool_result"`, it's a tool callback (D); if `content[0].type === "text"`, it's an operator turn that CC is echoing (H).

**Result:** content-block type alone is sufficient. No new field, no schema change. The renderer branches on `content_block.type`.

## Decision 6 — Approve / Deny affordance renders but does not wire

§5.3.1 specifies inline Approve / Deny buttons on `permission.request` event rows. The wire protocol depends on CC stream-json supporting structured permission events + stdin approval — a Phase A verification item that has **not** been confirmed (design spec §11 item 10).

**F-7 behaviour:**
- `permission.request` rows render at primary weight with visually present Approve / Deny buttons.
- Both buttons are **disabled** and carry a tooltip: "Approve/deny wiring ships after CC stream-json permission protocol is verified (design §5.3.1)."
- Text-based "deny with instructions to try differently" is still unavailable in F-7 because section ③ is disabled (Decision 1). Operators handle permission requests out-of-band (directly in the CC session) until F-10 and the verification land.

**Why render at all?** So the attention view has the permission-request UI present from day one; when the verification lands and the wire protocol is implemented, the change is button enable + handler attach, not a layout reshape.

## Decision 7 — Summary header content is minimal in F-7

§5.2 specifies collapsed-by-default: agent × task, state, one-line block reason, dispatch cycle. F-7 ships all of these **except** two simplifications:

**Kept:**
- Agent name, task title, current state.
- Block reason one-liner (reuse `blockReasonOneLiner` from F-6's dashboard code).
- Dispatch cycle counter: computed at read-time as `COUNT(*) FROM events WHERE session_id = ? AND type = 'state.transition' AND json_extract(payload, '$.to') = 'dispatched'` + 1. Cheap, correct, no schema change.

**Deferred to a later iteration (F-7 renders state-only, no extracted intent):**
- Running-state intent extraction ("last assistant message, first sentence, 8–16 words"). §5.2 describes the heuristic; we can ship it, but F-7's minimum viable summary is "State: running" without the extracted intent. Adding the extraction is a later pass; keeping it out of F-7 reduces scope and avoids subjective-quality debates in review.

**Expanded header (§5.2 second paragraph):** shows the full `block_reason` payload (all fields), the task `sourceRef` if set, and assignment metadata (ID, operator_id, timestamps). Ships in F-7 — it is a flat render of existing fields, no new computation.

## Decision 8 — Virtualisation is hand-rolled, no new dependencies

The dashboard is a single inline HTML/JS file with no build step. Adding a virtualisation library (react-window, tanstack-virtual, etc.) would force us into a bundler. Out of scope.

**Approach:** a windowed renderer that paints the last N events (N = 40 to keep a comfortable scroll buffer over the §5.3 "default 20" spec number). Older events backfill on scroll-up via `GET /api/assignments/:id/events?before=<oldestSeq>`. New events from WS prepend at the top.

**Memory bound:** client-side cap of 500 rendered rows; oldest drop off the bottom on scroll-down past the cap. Honest trade-off — re-fetch on scroll-back rather than unbounded memory growth.

No DOM recycling (simple append/prepend + `max-height` + `overflow: auto`). 500 rows of compact log entries is under 1 MB DOM — well within budget. If perf regresses later, revisit.

## Decision 9 — One drill-down at a time

§5.5 already says this. F-7 enforces it at the state level: opening a drill-down closes any previously open one. No multi-tab / side-by-side in F-7.

## Scope summary — what F-7 SHIPS

- `GET /api/assignments/:id/events` endpoint (Decision 3).
- Overlay drill-down panel triggered by Enter/click from focus area; Esc/outside-click closes (Decision 2).
- Three-section layout: summary header, virtualised event log, disabled input placeholder (Decisions 1, 7, 8).
- Per-row D/A/H colour classification at content-block granularity (Decisions 4, 5).
- Three visual weights per §5.3 (Decisions 4).
- `permission.request` rows with visually-present-but-disabled Approve/Deny (Decision 6).
- Dispatch cycle counter, block reason one-liner, expanded header fields (Decision 7).
- Tests: endpoint pagination (empty, single page, multi-page, limit clamp, 404), overlay keyboard (Enter opens, Esc closes), D/A/H classification unit test for content-block expansion.

## Scope summary — what F-7 DEFERS

- Operator text input submission (F-10 / Phase C).
- Approve / Deny wire protocol (Phase C + verification; spec §5.3.1).
- Running-state intent extraction in summary header (later iteration, §5.2 heuristic).
- Token-level streaming + RAF batching (CC stream-json emits whole messages; re-evaluate if CC adds token streaming).
- Hash routing for deep-linkable drill-down URLs (additive; F-10+ if needed).
- Multi-session history view (current session only; see Decision 3).

## Acceptance criteria

- [ ] `GET /api/assignments/:id/events` returns paginated events ordered ascending by `seq`, supports `before` + `limit`, clamps `limit` to 200, 404s unknown IDs.
- [ ] From focus area, `Enter` on a selected card opens the drill-down overlay; `Esc` closes it; clicking outside closes it.
- [ ] Drill-down renders three sections (summary, event log, disabled input placeholder) per §5.1.
- [ ] Summary header shows collapsed view by default with agent × task, state, block reason one-liner, dispatch cycle; clicking expands to full payload + task sourceRef + assignment metadata.
- [ ] Event log renders time-descending with three visual weights and D/A/H colour accents per Decision 4. Tool-use/tool-result rows collapsed by default; click expands.
- [ ] `permission.request` rows render with disabled Approve/Deny buttons and a tooltip explaining the Phase C gate.
- [ ] Scroll-up past the loaded events triggers backfill via the new endpoint.
- [ ] Live WS `event` frames for the open drill-down's session prepend to the log.
- [ ] Opening a second drill-down closes the first (Decision 9).
- [ ] All existing mission-control tests still pass; new tests for endpoint + overlay + classification ship green.

## Where this goes

- New endpoint: `src/mission-control/api/handlers.ts` + route in `server.ts` + types in `api/types.ts`.
- DB query: extend `src/mission-control/db/events.ts` with `listEventsForAssignment(db, assignmentId, { before?, limit? })`.
- Dashboard: `src/mission-control/dashboard/index.html` — new overlay panel section, event row renderer, keyboard bindings.
- Tests: `src/mission-control/__tests__/api.test.ts` (endpoint), plus a new `__tests__/attention-view.test.ts` for the WS+overlay wiring if it grows beyond a few cases.

Forward-link from the main spec §5 added in the same PR that lands this addendum.
