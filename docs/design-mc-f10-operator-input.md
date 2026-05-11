# F-10 — Operator input affordance (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f10-operator-input.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §5.1 (attention view section ③), §6 (operator input channel), and §6.3 (input queue).
**Date:** 2026-04-24.
**Status:** Decided. Resolves the open questions enumerated below before F-10 implementation begins.

## Why this addendum

F-10 is the first Phase C feature — the one that turns the cockpit from monitor to console. §6 sets out the Maestro-borrowed input model (stdin piping via session endpoint, client-side execution queue, images via base64), but the concrete shape of the dashboard affordance, the queue UX, the error-path behaviour, the observed-session handling, and the scope of image support on this PR have all been deferred to implementation time. F-6 / F-7 / F-8 / F-9 each shipped with a pre-implementation addendum; F-10 follows the same discipline.

Critically: a lot of F-10's plumbing already exists. The backend `POST /api/assignments/:id/input`, the WS `operator.input` broadcast, the `state.queues` + `sendInput` + `releaseQueue` trio in the dashboard, and the F-7 drill-down's disabled textarea placeholder are all in place from earlier phases. F-10 is primarily a **wire-up**, not a greenfield build. This addendum keeps the scope honest to that reality.

## Decision 1 — F-10 ships text-only input; images are a separate follow-up

§6.2 specifies paste + drag-drop images via base64 data URLs embedded in stream-json. The iteration plan lists image storage/rendering as a **separate line item** under Phase C, not part of F-10 itself. Landing both in one PR would bundle:

- A CC stream-json message-framing extension (current `buildStreamJsonMessage` is text-only — a rich-content frame requires the `content: [{type:"text", ...}, {type:"image", source:{...}}]` shape Maestro uses).
- An event-renderer extension (F-7's attention-view row expander doesn't yet know how to display image content blocks — it currently text-only).
- A storage-or-passthrough decision (base64 inflates event-table payload; v1 is "no upload step, just embed", but event retention and export implications should be sized against reality).
- Per-platform clipboard quirks on paste (Safari vs Chromium vs Firefox).

**Choice.** F-10 ships **text-only**. Images remain explicitly deferred to a Phase C follow-up — tracked by the "Image/screenshot paste + drag-drop" bullet in `docs/iteration-mission-control.md`; no sub-letter or separate feature-id, just the follow-up PR when stream-json content-blocks + the event-renderer image support land in lockstep. The F-7 drill-down's input placeholder is replaced with a live textarea for text; the attention view's event renderer stays unchanged for images (when they land, both the stream-json framer and the renderer extend in lockstep).

**Why this split isn't scope-avoidance.** Operator text input on its own is the capability change that moves "console" from vaporware to lived reality. Images are a comfort upgrade on top of that reality, not the reality itself. Shipping text-only unlocks all the daily-driver workflows; images unblock a subset (paste-a-screenshot-and-say-fix-this) that operators can work around today by saving the screenshot and describing its content, pasting a URL, or using a local `cldyo-live` session. Not a functional regression — just an absent convenience.

## Decision 2 — Submit is Enter; Shift+Enter is newline

Standard chat UX. Matches Maestro, matches operator muscle memory from Claude desktop, matches every dashboard the operator already uses. `Cmd+Enter` / `Ctrl+Enter` is **not** bound as a secondary submit — two submit keys on the same affordance tempt operators into "which one did I press" doubt which is the opposite of the console's job. If a future operator-set disagrees, add a second bind then; don't pre-allocate friction.

**Empty submit** (whitespace-only input after `trim()`) is a no-op with no error message. Not worth a toast.

**Max input length.** Capped at **50 KB** client-side (Maestro's limit is similar order of magnitude; the `maxPayloadLength` config on the WS side is unrelated — this is the HTTP POST body). Above the cap, the submit button disables and a counter shows `50034 / 51200 chars`. Pasting a large chunk that exceeds the cap trims to the cap with a one-line notice, not a silent truncation. This is a UX safety rail, not a security control. Today `handleSendInput` in `src/mission-control/api/handlers.ts` only validates `body.text` as a non-empty string with no upper bound; adding a server-side length check is a small follow-up tracked alongside F-10, so the client cap is the only bound in place until that lands.

## Decision 3 — Wire-up lives in the F-7 drill-down; the v1 placeholder input stays untouched

F-7 ships `#drill .drill-input textarea` as a disabled placeholder (Decision 1 of the F-7 addendum). F-10 enables it. The v1 PR#1 placeholder `.list/.detail` panel in `<main>` keeps its own input, which is already functional against the same endpoint — removing it is a **Phase C cleanup** that can land in a small follow-up chore PR after F-10 has had some use. Scope-avoidance is not the intent; leaving the placeholder gives the operator a working escape hatch if the drill-down overlay has a regression post-merge.

**When to remove the placeholder.** After F-10 lands, the v1 placeholder and the F-7 drill-down both accept text input for the same assignment. The placeholder is strictly inferior (no event log in view). Removing it when F-10 has observably worked in daily use is straightforward: delete the `<section class="list">` start-session form and `.detail` panel; keep the v1 placeholder's existing state + renderList code path wired into F-8's task table (already is). Not in F-10.

## Decision 4 — Reuse `POST /api/assignments/:id/input` unchanged

The endpoint already exists (from PR #1, extended in F-3), handles text, broadcasts `operator.input` events, rolls back on write failure, and distinguishes `NotControllable` (409) from `SessionClosed` (410) from generic 5xx. F-10 touches **no** server code. The dashboard re-uses `sendInput(assignmentId, text)` unchanged; all changes are in the drill-down wire-up (`.drill-input` DOM + submit handler + queue-state rendering).

**Why not WebSocket `writeToSession`.** §6.1 frames grove-bot as "browser → WebSocket → grove-bot" conceptually, but the concrete wire-up in v2 uses HTTP POST because:

1. POST is already wired end-to-end, tested, and rolled out.
2. Inputs are low-frequency (operator keystrokes, not tool call streams). A round-trip latency of 20 ms over HTTP is imperceptible.
3. Moving to WS-write would add a duplex message-type to the WS contract for zero user-visible benefit in v1. When tool-result streaming in the other direction arrives, the upgrade is additive and can co-exist.

This leaves the transport-neutral phrase in §6.1 accurate: the dashboard **does** speak to grove-bot which **does** resolve an endpoint which **does** write to CC stdin. The concrete pipe is HTTP, not WS. Documented here so future readers don't re-open the debate.

## Decision 5 — Queue semantics: reuse the existing `state.queues` + surface depth in the drill-down

`state.queues` already exists, typed `Map<assignmentId, { busy: boolean, queue: string[] }>`. `sendInput` / `releaseQueue` are already implemented in line with §6.3. F-10 renders the queue depth **in the drill-down input area** (where the operator sees it) rather than only in the v1 placeholder `.detail` column (where they have to look for it).

**Visual rules:**

- Submit button label states: `Send` (idle) → `Sending…` (in-flight) → `Queued (+N)` when busy AND queue depth > 0.
- Below the textarea: a thin inline hint shows `Queued: N` when N > 0, disappears when N = 0.
- When the drill-down is open on an assignment whose queue is non-empty, the hint renders on open (rehydrated from `state.queues` lookup).
- Queued items are **not** visible as draft-list chips in v1 — "what did I queue" is addressed in a later iteration. Matches Maestro's restraint.

**Queue-release heuristic (inherited).** `releaseQueue` fires from the `state.transition` WS handler in `src/mission-control/dashboard/index.html` (single call site, around line 794) — correct for turn-boundary transitions, but too eager when an agent emits mid-turn hand-backs with no state change. The existing `TODO(F-A4)` comment immediately above the call site already documents the upgrade plan: release on the terminal event of a turn (e.g. stream-json `result`) once the stdout stream-json dispatcher surfaces a turn-end event type. F-10 inherits the behaviour unchanged; the follow-up is tracked by that TODO, not a F-10 blocker. The F-10 PR description will call this out explicitly so a reviewer doesn't flag it as new regression territory.

## Decision 6 — Observed sessions disable the textarea at the UI layer; server still returns 409 as the truth

For an assignment whose active session has `endpoint_kind === 'local.observed'`, the write path throws `NotControllable` and the endpoint returns 409. F-10 also disables the textarea and submit button at the UI layer with a one-line note: **"This session is observed. Input ships when you open it in a controlled Grove session."** The drill-down still renders the event log read-only (matches F-7's read-only posture for observed data).

**Why a UI gate in addition to the 409.** Avoids the "type 200 characters, hit Send, learn it's observed" surprise. The 409 remains the authoritative answer — a race where the endpoint flips between fetches is still handled by the server's rejection. The UI gate is UX.

**Where the UI gate comes from.** `state.drill.assignmentId` → lookup in `state.assignments` → `session.endpoint_kind`. `listAssignments` already surfaces `session.endpoint_kind`. No new endpoint surface. If the drill-down opens on an assignment that the dashboard doesn't yet have in `state.assignments` (e.g. a fresh drill-down before `fetchAssignments` completes), default to enabled — the 409 will catch it.

## Decision 7 — Approve/Deny on `permission.request` rows stays disabled in F-10

F-7 Decision 6 explicitly gates Approve/Deny on CC stream-json permission-protocol verification, which has **not** happened yet (design spec §11 item 10 remains open). F-10 is input-return; it does not subsume that verification.

**F-10 does NOT wire Approve/Deny.** The disabled-with-tooltip placeholder from F-7 stays in place. Approve/Deny becomes a clean follow-up after the verification lands — "button enable + handler attach", matching F-7's original framing.

**Text-based deny.** §5.3.1 mentions "deny with instructions to try differently" — an operator reply via the text input that functionally vetoes a pending permission request. With F-10's text input live, the operator **can** type a deny-and-explain message, and the agent will see it mid-turn. CC's behaviour on that input is not something F-10 can engineer — we surface the channel, CC does what CC does. The design-spec language ("deny with instructions to try differently") is therefore implicitly satisfied via normal text input. No additional UI treatment in F-10.

## Decision 8 — Error UX: inline banner inside `.drill-input`, not the global error pill

Today `sendInput` calls `showError()` on failure, which writes to the global `#err` pill at the top of the v1 placeholder `.list` section — not visible when the drill-down overlay is open. F-10 adds an **inline error slot inside the drill-down input area**, rendered above the textarea on write failure with:

```
⚠ Send failed: {message}                                    [Retry] [Dismiss]
```

- `Retry` re-submits the same text (preserves what the operator typed).
- `Dismiss` clears the banner without retrying.
- The textarea is not cleared on failure (preserves work).
- The banner auto-clears on the next successful send.

The global `showError` is still called so it's visible if the operator closes the drill-down; inline banner is additive. Matches the F-8 review learning (grid-refresh errors stopped using `showError` because they over-shadowed F-6/F-8 errors — PR #15 sweep). Different case here (input failure is itself an action the operator just took, so it belongs inline), but the principle of "put the error where the operator is looking" is the same.

**Status-code-specific copy:**

- `404` — "No active session for this assignment. Start or dispatch a session first."
- `409` — "This session is observed and cannot be written to." (Shouldn't reach UI given Decision 6, but handle defensively.)
- `410` — "The session has ended. Reopen the assignment to start a new one."
- `500` / other — "Send failed: {server message}"

## Decision 9 — No input when the session is null (drill-down on a task with no session)

A task that was dispatched but whose session ended (e.g. completed, failed) and is being drilled-into for history review. F-10 disables the textarea with a one-line note: **"Session ended. History is read-only."** This is the same "disabled input" pattern as observed sessions (Decision 6) with different copy, and is consistent with the F-7 drill-down already rendering events after the turn ends.

**Empty-assignment tasks** (the F-8 Decision 5 case where the operator opened the drill-down on a task with zero assignments): the drill-down doesn't open in that case — F-8 already surfaces "Manual dispatch ships in Phase E (F-12)" as an error-pill message, and the drill-down never gets an assignment ID to work with. Not an F-10 concern.

## Decision 10 — Audit-log aggregation stays as-is; `operator.input` is already the first-class event

§6.4 specifies "full audit log of operator ↔ agent interactions, across all agents", implemented as `operator.input` events in the `events` table. That is **already true** post-F-3. The existing event stream in `events` is the audit log. The F-7 attention view already renders `operator.input` as an H-coloured primary row in the event log.

**F-10 does not need to add aggregation surface.** An operator-across-agents view ("show me everything I typed today") is either:

- Implicit via the F-8 table (click any task, see the drill-down events).
- Or a dedicated per-operator event feed — post-Phase-B at earliest, no operator has asked for it, and adding it now is scope creep.

Explicitly not in F-10.

## Scope summary — what F-10 SHIPS

- F-7 drill-down `.drill-input` textarea enabled, styled for active input (remove disabled/dashed-border styling).
- Submit on Enter, newline on Shift+Enter, disabled when empty or over 50 KB (Decision 2).
- Wire-up to existing `sendInput(assignmentId, text)` — no new server surface, reuses `POST /api/assignments/:id/input` unchanged (Decision 4).
- Submit button label states: `Send` / `Sending…` / `Queued (+N)` (Decision 5).
- Inline queue-depth hint below textarea (Decision 5).
- Inline error banner in drill-down input area with `Retry` / `Dismiss` + status-code-specific copy (Decision 8).
- Observed-session UI gate — disabled textarea with explanatory copy (Decision 6).
- Ended-session UI gate — disabled textarea with "Session ended. History is read-only." (Decision 9).
- Textarea preserves text on failure, clears on success.
- The drill-down title-bar state pill (added in F-7) continues to reflect assignment state; no new visual treatment.
- Tests: sendInput happy path (already covered for the v1 placeholder — extend or re-use); drill-down input submit routes to sendInput; disabled state for observed sessions; disabled state for ended sessions; Enter vs Shift+Enter; empty-submit no-op; 50 KB cap; inline error banner renders on 500; queue depth renders when busy.

## Scope summary — what F-10 DEFERS

- Image paste + drag-drop (a separate PR once stream-json content-blocks + event-renderer image support land together — Decision 1).
- Text-based Approve/Deny wiring on `permission.request` rows beyond what plain text already does (Decision 7 — blocked on CC stream-json permission-protocol verification).
- Per-operator cross-agent audit view (Decision 10 — implicit via F-7/F-8 already; dedicated view is post-Phase-B).
- Upgrading the queue-release heuristic from "any WS event" to "assistant-turn-end" (Decision 5 — follow-up chore; not new regression).
- v1 placeholder `.list/.detail` panel removal (Decision 3 — follow-up chore PR after F-10 has been in use).
- Durable queue persistence across reloads (§6.3 — post-v2 explicitly).

## Acceptance criteria

- [ ] Drill-down textarea is enabled for `local.process.controlled` sessions; Enter sends, Shift+Enter newlines.
- [ ] Submit routes through `sendInput`; operator sees optimistic "Sending…" during the call.
- [ ] On success, textarea clears; the posted text appears in the event log as an `operator.input` H-coloured row within one WS tick.
- [ ] On 409 / 410 / 5xx, an inline error banner renders with the status-code-specific copy from Decision 8 and a `Retry` / `Dismiss` control; the textarea value is preserved.
- [ ] Observed-session assignments show a disabled textarea + "This session is observed..." note.
- [ ] Ended-session assignments (no active session) show a disabled textarea + "Session ended. History is read-only." note.
- [ ] Queue depth `> 0` shows below the textarea; submit button reads `Queued (+N)`.
- [ ] Input > 50 KB disables the submit button and shows a character counter; paste events over the cap trim with a notice.
- [ ] Approve/Deny buttons on `permission.request` rows stay disabled (no change from F-7).
- [ ] All existing mission-control tests still pass; new tests for the drill-down submit wire-up, disabled states, 50 KB cap, and inline error ship green.

## Where this goes

- Dashboard: `src/mission-control/dashboard/index.html` — replace the disabled textarea with an active form, add submit handler, queue-depth hint, inline error banner, observed/ended disable logic.
- Tests: `src/mission-control/__tests__/api.test.ts` if any new endpoint behaviour is touched (there shouldn't be). Likely a new `__tests__/drill-input.test.ts` for the dashboard-level submit wire-up if the pure functions can be extracted cleanly.
- No server code. No schema changes. No new DB modules.

Forward-link from the main spec §5.1 and §6.1 added in the same PR that lands this addendum.
