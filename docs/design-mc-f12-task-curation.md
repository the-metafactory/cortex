# F-12 — Task curation UX (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f12-task-curation.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §3 (the task funnel) and §9 Phase E.
**Date:** 2026-04-24.
**Status:** Decided. Resolves the open questions enumerated below before F-12 implementation begins.

## Why this addendum

§3 establishes the task as the vessel for orchestration and the funnel as `source backlogs → curated queue → dispatch → work`. §3.4's last paragraph names the curation UX in one sentence: *"the task view itself"*, with task-opening and attention-drill-down sharing one entry point. §8.5 reinforces it: *"If no active assignment exists, the task detail shows the task metadata + [Dispatch] button"*. §9 Phase E unfolds that line into five capabilities — add-to-queue from GitHub, manual dispatch, requeue, abandon, hand-off. The iteration tracker's Phase E bullet repeats the same five.

Five capabilities sounds like five PRs, but the actual surface area is small: every action mutates one or two existing rows (`tasks` and/or `agent_task_assignment`) plus one `events` row, and every action lives on a UI that already exists (the F-7 drill-down overlay reached via the F-8 task table). F-7 / F-8 / F-10 each shipped placeholder hooks for these very actions — F-8's disabled `Dispatch (Phase E)` button is the most explicit. F-12 fills in those hooks. The state machine, the audit log, the permission posture, the dashboard topology — all already in place. Pre-implementation discipline matters here because it's tempting to over-build (a tasks-create CRUD module, a side-panel curation pane, slash commands) when the actual win is "wire the verbs that already exist into a UI that already exists, behind a few new endpoints".

**Invariant the implementer must absorb — `tasks.status` and `agent_task_assignment.state` are different state machines.** `tasks.status ∈ {open, in_progress, done, cancelled}` (per `src/mission-control/db/schema.ts:31`); `agent_task_assignment.state ∈ {queued, dispatched, running, blocked, completed, failed, cancelled}` (per `src/mission-control/db/schema.ts:54`). The two are correlated but not coupled: F-12's "abandon" and "hand-off" decisions both pivot on which row each verb writes to. The CHECK constraint at `src/mission-control/db/schema.ts:62` (`(state = 'blocked') = (block_reason IS NOT NULL)`) is also load-bearing — F-12 mutations that touch state must clear `block_reason` correctly. Decisions 4–6 below pin which row each verb mutates and how `block_reason` is treated.

## Decision 1 — Scope: ship four of the five Phase E verbs in F-12; defer add-to-queue from GitHub to F-12b

The iteration tracker bullet names five capabilities — "add to queue from GitHub issue, manual dispatch, manual requeue, abandon, hand-off". F-12 ships **four**: manual dispatch, requeue, abandon, hand-off. **Add-to-queue from a GitHub issue is split into a sibling PR (F-12b)**, landing immediately after F-12 against the same Phase E iteration bullet.

The split is not arbitrary: the four shipped verbs are all assignment-state mutations on tasks that **already exist** in the `tasks` table — they reuse `applyTransition` (`src/mission-control/db/transitions.ts:42`) plus a single new `applyPrincipalAction` wrapper, plus three new endpoints with near-identical shapes. A reviewer can audit them as a class. Add-to-queue is qualitatively different: it spans `tasks.source_url` parsing, an external-source fetch (calling out to `gh` or the GitHub API to extract title/body for prefill), URL-validation and SSRF posture, an "is this issue already a task?" duplicate-check against `tasks.source_external_id`, and a UI that doesn't yet exist anywhere on the dashboard (no current screen has a "create task" affordance). Folding it into the same PR halves the reviewer's ability to audit the assignment-state-mutation class against the funnel and the state machine.

**F-12b is a separate addendum, separate PR, separate review.** Iteration-tracker-bullet-wise the two collectively close the Phase E checkbox. F-12 gets shipped first because it makes the existing dashboard's task table (built from tasks created by `POST /api/sessions`) actually curatable; F-12b makes the table fillable from outside the dashboard. Useful to ship F-12 first because principals today have no way to abandon a stuck task without manual SQL — that's the larger pain. Add-to-queue is additive convenience; abandon/requeue/hand-off are pain relief.

This addendum covers F-12 only. F-12b will get its own pre-implementation addendum in the same Phase E iteration-tracker bullet.

## Decision 2 — All four verbs live as buttons in the F-7 drill-down overlay; no side panel, no separate route

§8.5 pins the principle: *"task detail == attention drill-down"* — opening a task and drilling into an attention card are the same UI. F-12 inherits this. The F-7 drill-down overlay (`#drill` in `src/mission-control/dashboard/index.html`, opened via `openDrillDown(assignmentId)` at line ~2128 and via `openTaskDrillDown(task)` at line 2122) is the single home for all four verbs.

Concretely, F-12 adds a **curation toolbar** as a single horizontal row immediately above the F-10 input affordance, inside the existing `#drill` panel. The toolbar renders four buttons keyed off the assignment's current state — only legal verbs are enabled, the rest render as disabled with a tooltip explaining why. Decision 3's enablement matrix is the truth.

```
┌── #drill ──────────────────────────────────────────────────┐
│  T-42 "fix webhook HMAC verification"  · P0 · Luna         │
│  ┌─ summary header (F-7 §5.2) ─────────────────────────┐   │
│  │ ...                                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ event log (F-7 §5.3) ─────────────────────────────┐    │
│  │ ...                                                │    │
│  └────────────────────────────────────────────────────┘    │
│  ┌─ curation toolbar (F-12 NEW) ──────────────────────┐    │
│  │ [Dispatch ▾] [Requeue] [Hand off ▾] [Abandon]      │    │
│  └────────────────────────────────────────────────────┘    │
│  ┌─ input affordance (F-10) ──────────────────────────┐    │
│  │ [textarea]                       [Send]            │    │
│  └────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────┘
```

**No side panel, no separate `/curate` route, no separate task-detail page.** The dashboard has a single primary surface (the focus area + working grid + task table) and a single overlay (the drill-down). Adding a third surface to host curation buttons trades one click for two screens of principal cognitive load — the wrong trade. The drill-down is already where the principal goes when they think *"this task is stuck / wrong / done with the wrong agent"*; the verbs they need at that moment belong on that screen.

**Empty-assignment tasks (Phase E un-dispatched).** Deferred to F-12b along with the GitHub-import path that produces them. F-12 alone cannot create a zero-assignment task (`POST /api/sessions` always spawns), so the F-8 error pill at `dashboard/index.html:2134` (*"This task has no assignment yet. Manual dispatch ships in Phase E (F-12)."*) stays in place until F-12b lands. F-12b's addendum will replace the error pill with the stripped-down drill-down (task metadata + curation toolbar with only `[Dispatch]` enabled) at the same call site. Keeping this scaffolding out of F-12 avoids shipping dead code that has no producer.

**Why not a contextual right-click menu.** Right-click is undiscoverable on touch devices and inconsistent with the rest of the dashboard (everything else is left-click toolbars). A visible toolbar matches the F-10 input affordance pattern from the same drill-down — same panel, same visual weight, same affordance discipline.

## Decision 3 — Per-state enablement matrix; the toolbar is purely view-derived

The toolbar is a pure function of `assignment.state`. The implementer must not duplicate the state machine's transition rules in the UI — the matrix below is derived directly from `src/mission-control/state-machine.ts`'s `TRANSITIONS` table, with one extension (Decision 5's "abandon" verb) that has no state-machine equivalent.

| state | Dispatch | Requeue | Hand off | Abandon |
|---|---|---|---|---|
| `queued` | ❌ already-dispatched-class | ❌ no-op | ✅ swap agent | ✅ |
| `dispatched` | ❌ already-running-class | ❌ no-op | ✅ swap agent | ✅ |
| `running` | ❌ already-running-class | ❌ no-op | ✅ swap agent | ✅ |
| `blocked` | ❌ already-running-class | ✅ → `queued` | ✅ swap agent | ✅ |
| `failed` | ❌ terminal | ✅ → `queued` | ✅ new assignment, new agent | ✅ |
| `completed` | ❌ terminal | ❌ rerun creates new assignment via Dispatch | ❌ task already done | ✅ (principal may close out the task even from completed) |
| `cancelled` | ❌ terminal | ❌ already-cancelled | ❌ already-cancelled | ❌ already-cancelled |
| no assignments yet (empty-assignment task) | ⏭ F-12b | ❌ nothing to requeue | ❌ nothing to hand off | ⏭ F-12b (Abandon-the-task) |

**Empty-assignment row deferred.** F-12 keeps to the assignment-keyed surface — every endpoint takes `:id` as an assignment id. A zero-assignment task cannot be produced by any flow inside F-12 (`POST /api/sessions` always spawns; the GitHub-import path is F-12b's). F-12b's addendum lands the empty-assignment task-creation path AND the matching `POST /api/tasks/:taskId/abandon` endpoint together, where the row has a real call site. Until then, the empty-assignment Dispatch and Abandon cells are markers, not shipped behaviour.

**`Dispatch` enablement.** Enabled in two cases: (a) the task has zero assignments (empty-assignment), or (b) the task's primary active assignment is in a terminal state (`completed`/`failed`/`cancelled`) and the principal wants a fresh re-run on the same task. For terminal-state Dispatch, the new row is a fresh `agent_task_assignment` — the existing terminal row is preserved as historical record (matches F-8 Decision 4's handling of terminal-state assignments rendering with strike-through-on-hover).

**`Requeue` enablement.** Strict mirror of the state machine's `principal_requeue` action — legal from `blocked` and `failed` only. The state machine already enforces this; the toolbar reflects it.

**`Hand off` enablement.** Legal from any non-terminal state on the assignment row, including `failed` (the principal says *"that agent gave up; let a different one try the same task"*). Disabled on `completed` and `cancelled` because there's no in-flight work to hand off. From terminal-but-rerunnable states (`failed`), Hand off is semantically equivalent to "Dispatch with a new agent" — Decision 6 pins the implementation: hand-off from a terminal state creates a new assignment row to the new agent (same as Dispatch), hand-off from a non-terminal state cancels the current assignment and creates a new one (true mid-flight reassignment).

**`Abandon` enablement.** Legal from any non-terminal state (`queued`/`dispatched`/`running`/`blocked`) on the assignment AND legal from `completed` on the task (principal closing out). Disabled on `cancelled` (task already cancelled). Decision 5 pins what "abandon" actually does at the row level.

**Disabled buttons render with tooltips.** Each disabled button gets a one-line tooltip from the matrix above ("Already running — cannot dispatch", "Task already cancelled", etc.) so principals learn the model from the UI without reading docs.

## Decision 4 — Manual dispatch: agent picker is a dropdown of all `agents` rows, defaulting to the F-8 ordering

§8.5 says *"[Dispatch] button that creates an assignment to a chosen head"*. Two questions: where does the agent list come from, and what's the default?

**Agent list source.** The full `agents` table — every row, regardless of `type` (`head`/`hands`) or `persistent` flag. Rationale: F-12 is principal-facing, not policy-driven, and the principal may legitimately dispatch to either type. Filtering would hide the available choice without making it safer (any agent the principal can name in the dropdown was already a valid dispatch target via the existing `POST /api/sessions` flow).

**Default.** `mc-default-agent` (the well-known row created lazily by `ensureDefaultAgent` in `src/mission-control/api/handlers.ts:257`). The principal can override before clicking. If multiple agents exist, the dropdown sorts by `agents.name ASC` with the default pinned to the top.

**UI shape.** `[Dispatch ▾]` is a split button — clicking the main label dispatches to the default; clicking the chevron opens a dropdown of all agents. Matches Decision 6's `[Hand off ▾]` shape so the two buttons feel symmetric.

**Endpoint backing it.** Reuses `POST /api/sessions` unchanged. The endpoint already accepts `taskId` (existing path — `handlers.ts:288`) and `agentId` (existing path — `handlers.ts:284`); F-12's wire shape is exactly what the dashboard already sends for the implicit "spawn from drill-down" path that doesn't yet exist. **No new endpoint.** Decision 9 covers the audit event.

**Empty-assignment Dispatch.** Deferred to F-12b. F-12 alone has no producer for zero-assignment tasks, so the wire path stays unexercised in F-12. The terminal-state Dispatch case (re-run from a `failed`/`completed`/`cancelled` assignment) is the only re-Dispatch path F-12 ships: it calls `POST /api/sessions` with the existing `taskId` — the endpoint creates a fresh `agent_task_assignment` row alongside the terminal one (no merging, no row reuse). Schema-wise this is already supported (`agent_task_assignment` has no UNIQUE constraint on `(task_id, agent_id)` — verified at `src/mission-control/db/schema.ts:50–65`).

**Why not a tighter "head-agents-only" filter.** Concern 5 in the parent spec explicitly retired the `pets/cattle` taxonomy and replaced it with `persistent: bool` + `head/hands`. F-12 does not re-introduce a policy on top — the `type` column is metadata for the principal's mental model, not an access-control gate.

## Decision 5 — Abandon: cancels the assignment when one is active, cancels the task when not

"Abandon" is overloaded. The button might mean *"the agent is going down a wrong path; stop it"* (cancel the assignment) or *"this whole task is no longer relevant; close it out"* (cancel the task). F-12 does both, branching on context.

**Concrete semantics:**

- **Active assignment present (`queued`/`dispatched`/`running`/`blocked`):** Abandon cancels the **current assignment** by issuing the state-machine `cancel` action — `applyTransition(db, assignmentId, sessionId, { type: 'cancel' })`. The state machine already supports this (`src/mission-control/state-machine.ts:29,36,45,53`). Side effect: any controlled session is closed via the new state-transition observer pinned in Decision 11 (the existing `processManager` plumbing kills only on `closeAll` shutdown, so F-12 introduces an explicit observer that calls `endpoint.close()` when an assignment moves into `cancelled`). The task row is **not** mutated; the principal can spawn a new assignment via Dispatch if they change their mind.
- **No active assignment, all assignments terminal, task is `completed`/`done`:** Abandon cancels the **task** — `UPDATE tasks SET status = 'cancelled', updated_at = unixepoch()`. No assignment-side mutation (there's nothing in flight). The principal may want to mark a "done" task as no-longer-relevant; this is the escape hatch.
- **Task already `cancelled`:** Button disabled per Decision 3.
- **Zero-assignment task (no assignments ever created):** Deferred to F-12b. See Decisions 3 and 9 for the carryover rationale — F-12 cannot today produce a zero-assignment task (`POST /api/sessions` always spawns), so the row in Decision 3's matrix exists only to describe behaviour that lands once F-12b adds the GitHub-import path.

**`block_reason` clearance.** Cancelling from `blocked` triggers the state-machine `cancel` action; the existing `transition()` function returns `blockReason: null` for any non-`block` action (`state-machine.ts:93`), which is then written to `agent_task_assignment.block_reason`. The schema CHECK constraint (`schema.ts:62`) is satisfied. Implementer doesn't need to do anything special — the existing path is correct.

**Confirmation dialog (Decision 8 covers the full posture).** Yes, abandon prompts for confirmation. Free-text reason field is optional. The reason becomes the payload of the `principal.curation` audit event (Decision 9).

**What about cascading?** Abandon-the-task does **not** cascade-cancel any other assignments on that task. Tasks can have multiple assignments (Concern 2 Q2.4 / §3.3); the principal may have a `running` assignment on the same task and Abandon should not blindly take it down. F-12's button operates on the **drill-down's primary active assignment**, full stop. If the principal wants to nuke all assignments on a task, they Abandon each one in turn. This is intentional restraint — bulk operations are explicitly out of scope (Decision 10).

**What about pending sessions?** The state-machine `cancel` action transitions the assignment to `cancelled`. F-12 introduces a new `state.transition` observer (Decision 11) that calls `endpoint.close()` on the matching session whenever an assignment lands in `cancelled`. The session row's `ended_at` is then set by the existing `endSession` path inside `endpoint.close()` (`src/mission-control/session/endpoint-resolver.ts:289-290`). The previous claim — that the existing `processManager` plumbing already closes the process on terminal transitions — was incorrect: `ProcessManager.closeAll` only fires on server shutdown (`src/mission-control/session/process-manager.ts:65`), and `proc.exited.then(...)` (`endpoint-resolver.ts:170-188`) cleans up *after* the process exits on its own; neither path is triggered by `applyTransition`. Decision 11 closes that gap.

## Decision 6 — Hand-off: cancel-current-and-spawn-new for in-flight; new-assignment-only for terminal

Hand-off is *"reassign the task from agent A to agent B"*. The semantics are different depending on whether the source assignment is in flight or terminal.

**In-flight hand-off (`queued`/`dispatched`/`running`/`blocked`):**

1. Cancel the current assignment via `applyTransition(db, currentAssignmentId, currentSessionId, { type: 'cancel' })`. Same path Abandon uses; same session-close side effect.
2. Create a new assignment row to the new agent on the same `task_id`, in `queued` state.
3. Spawn a controlled session for the new assignment. Same path `POST /api/sessions` already uses.

**Terminal hand-off (`failed` only — `completed`/`cancelled` are disabled per Decision 3):**

1. Skip step 1 (the assignment is already terminal — nothing to cancel).
2. Create the new assignment row + spawn (steps 2 and 3 above).

In both cases, the original assignment row is preserved — no rows are deleted, no rows are mutated except by legal state-machine transitions. The dashboard's task table renders both assignments (the terminal-or-cancelled original plus the new in-flight one) per F-8 Decision 4.

**Endpoint backing it.** A new endpoint, `POST /api/assignments/:id/handoff`, body `{ newAgentId: string }`. Returns `{ newAssignmentId, newSessionId }`. Internal implementation calls the existing `applyTransition` + `POST /api/sessions` machinery (in a single transaction for the cancel; the spawn is necessarily out-of-transaction because it forks a process). If the spawn fails after the cancel commits, the principal sees a fresh "task with no active assignment" — recoverable via Dispatch. The cancel is the irreversible part; the spawn is best-effort. Decision 9 covers the audit event.

**Why a new endpoint and not "cancel + sessions" client-side.** Atomicity: if the dashboard issues the cancel and the network drops before the spawn POST, the principal is left with a cancelled assignment and no replacement, which is observably worse than the current "stuck blocked" they were trying to fix. The server-side endpoint serialises the two steps and either both succeed (in-flight hand-off) or returns a coherent error. Client-side composition is also feasible and equivalently safe given F-12's single-principal posture, but server-side is cheaper to verify in code review. The single-endpoint shape is also closer to the verb principals reach for.

**Agent picker.** Same shape as Decision 4's Dispatch picker — full `agents` table dropdown, sorted by name. Default is the principal's choice (no implicit default — hand-off is an active decision, unlike Dispatch where defaulting to the well-known agent is a convenience). The split button `[Hand off ▾]` always opens the dropdown; there is no "main label click" shortcut (no implicit default).

**Why not a "swap agent" SQL update on the assignment row.** Because the existing assignment is already attached to a session (or has been); changing `agent_id` mid-flight would silently invalidate the session's correlation to the agent. Cleaner: cancel and respawn — the audit log is honest, the state machine stays simple, the session lifecycle stays clean.

## Decision 7 — Requeue: 1-to-1 mirror of the state machine's `principal_requeue` action

§3.3 describes two `principal_requeue` transitions: `blocked → queued` and `failed → queued`. The state machine implements both (`src/mission-control/state-machine.ts:52,59`). F-12's Requeue button is the principal's UI handle on these.

**Endpoint:** `POST /api/assignments/:id/requeue`. Body empty (no parameters). Returns the standard transition shape `{ assignmentId, from, to, blockReason: null }` for the WS broadcast pattern.

**Implementation:** `applyTransition(db, assignmentId, sessionId, { type: 'principal_requeue' })`, then `broadcastTransition` per the existing pattern at `handlers.ts:354`. The session associated with the previous run is **closed** by the new state-transition observer (Decision 11) — the observer calls `endpoint.close()` on the matching session whenever an assignment moves out of `running`/`blocked`/`dispatched` into a non-terminal-or-`queued` state. Without that observer, a Requeue from `blocked` would leave the live process untouched, and the next Dispatch would either hit `findActiveSession` and silently reuse the stale session (`endpoint-resolver.ts:96-105`) or throw `SessionConflict`. Requeue does **not** spawn a new session immediately; the assignment lands back in `queued` and a subsequent Dispatch (or auto-pickup, if F-13 dispatcher is wired in) starts a fresh run.

**Wait, doesn't that strand the assignment in `queued`?** Yes, until Dispatch fires. F-12's UX surfaces this clearly — after Requeue, the toolbar refreshes (Decision 3 matrix) and the principal sees `[Dispatch]` enabled while the other buttons return to their `queued`-state enabled state. An principal who Requeues a `failed` assignment and walks away gets a `queued` assignment that sits forever until either the F-13 dispatcher picks it up or another principal hits Dispatch. This is desirable: Requeue is *"this assignment was wrongly terminated; put it back on the runway"* — it's not *"and start it again right now"*. The latter is exactly what Dispatch on a terminal-state assignment does (Decision 4); principals who want both effects in one click should be told to use Dispatch directly.

**What about the `events` row?** The existing `applyTransition` already inserts a `state.transition` event with `payload.action = 'principal_requeue'`. F-12 adds a sibling `principal.curation` event (Decision 9) for the audit-trail-with-rationale shape. Two events for one principal action — the `state.transition` is the state-machine truth, the `principal.curation` is the principal-rationale truth. Both flow through the same `broadcastEvent` plumbing (`notifications.ts:43`).

## Decision 8 — Confirmation gates: Abandon and Hand-off prompt; Dispatch and Requeue do not

The bar is *"don't accidentally trigger destructive verbs"*, not *"match the rest of the design system"* (there is no design system). The dashboard has no precedent for inline confirmation, so F-12 introduces a small inline confirmation panel (shape pinned in the implementation note below) gated only on the destructive verbs. The matrix below pins which verbs prompt and which fire-and-forget.

| verb | Confirmation? | Free-text reason field? |
|---|---|---|
| Dispatch | ❌ — additive (creates a new assignment, hurts nothing if mistaken) | ❌ |
| Requeue | ❌ — reversible (principal can Abandon the requeued assignment if they change their mind) | ❌ |
| Hand off | ✅ — semi-destructive (cancels in-flight assignment) | ✅ optional |
| Abandon | ✅ — destructive (cancels assignment or task) | ✅ optional |

**Reason field.** Optional, single-line text input under the confirm prompt. When non-empty, the string lands in the `principal.curation` event's payload (Decision 9). When empty, the event still fires — just without rationale text. Principals who skip the field are not penalised; the audit row exists either way.

**Implementation note.** A `confirm()` dialog can't host a text field. F-12 uses a small inline confirmation panel that drops down from the button — same pattern as a context menu, dismissed on `Esc` or on click-outside. Two-stage interaction:

```
[Abandon]
   ↓ click
┌───────────────────────────────────────────┐
│ Cancel this assignment?                   │
│ Reason (optional): [_________________]    │
│              [Cancel]  [Confirm Abandon]  │
└───────────────────────────────────────────┘
```

**Keyboard.** `Esc` closes the confirm panel without acting; `Enter` confirms (matches F-10 input submit semantics). The reason field captures `Tab` correctly so the principal can flow Abandon → Tab → reason → Enter without a mouse.

**Why no global confirm-everything.** Dispatch and Requeue are reversible; gating them on confirmation slows down the day-two flow without protection benefit. The matrix mirrors the actual blast radius.

## Decision 9 — Audit trail: a single `principal.curation` event family with a `kind` discriminator

Each curation action writes one event in the `events` table for the F-7 drill-down to surface in the timeline. The four verbs are sibling enough that one event family with discriminator suits better than four parallel event types.

**Event type:** `principal.curation`.

**Payload shape (tagged union):**

```ts
type PrincipalCurationPayload =
  | { kind: "dispatch"; agentId: string; reason?: string; newAssignmentId?: string }
  | { kind: "requeue"; reason?: string }
  | { kind: "handoff"; fromAgentId: string; toAgentId: string; reason?: string;
      newAssignmentId: string }
  | { kind: "abandon"; targetKind: "assignment" | "task"; reason?: string };
```

**Why one event type with `kind`.** Mirrors the `block_reason` tagged-union pattern (`types.ts:54`) and the existing `state.transition` event's discrimination by `payload.action`. F-7's event log already renders by event-type → payload pattern; one new type plus four discriminator branches is one new render block in the dashboard, not four.

**Why not extend `principal.input` with a `payload.action` discriminator.** The user's review bar called out `principal.input` (`src/mission-control/db/events.ts:175,205`) as the established home for principal-authored events and asked why the curation verbs aren't members of that family. Three reasons F-12 keeps `principal.curation` separate:

- **Semantic conflation.** `principal.input` is a principal **utterance** — text the principal typed that the agent will read. Decision 3 of `events.ts` calls this out explicitly: *"principal.input is the authoritative H-source"*, meaning it's the human-channel input the agent acts on. Curation verbs are principal **actions on state** — they don't feed the agent, they reshape the funnel around it. Folding them into one type forces every `principal.input` consumer (dashboard renderer, future replay tooling, audit export) to branch on `payload.action` to decide *"is this text-the-agent-saw or a button-the-principal-clicked"*. That branch is wider than the curation-only `kind` branch because it also forks rendering (utterances render as chat bubbles; verbs render as state-change rows), attribution (utterances belong in the input-affordance lineage; verbs belong in the curation-toolbar lineage), and replay semantics (utterances would re-trigger agent behaviour on replay; verbs would not).
- **F-7 renderer branching cost.** F-7's drill-down renders `principal.input` as a chat bubble in the event log timeline. Reusing the type for curation verbs would either render four new payload variants as chat bubbles (semantically wrong — the principal did not "say" anything) or fork the renderer on `payload.action` to choose bubble vs state-change. That fork is the same one Decision 9's `principal.curation` block does, except the chat-bubble code path remains pristine and the curation block is its own self-contained renderer.
- **Multi-principal attribution at Tier 2.** §10's Tier 2 work introduces per-event `principal_id` columns. When that lands, `principal.input` and `principal.curation` will get the column wired in independently: utterances are attributed to whoever typed them, verbs are attributed to whoever clicked them. A unified type would have to negotiate the same column twice (once for each semantic), and any future per-family policy (e.g. *"only senior principals can fire `kind: handoff`"*) would have to gate inside `principal.input`'s authorization path — coupling utterance permissions to verb permissions.

The deviation from the bar is therefore deliberate: `principal.curation` is a sibling family, not a subset, and the `kind` discriminator scopes to the curation surface only. If a fifth verb lands (e.g. F-12b's `kind: "import"`), it joins the curation family; if a fifth utterance lands (e.g. an annotation surface), it joins `principal.input`. Two clean families beat one overloaded one.

**Where it's inserted.** Each new endpoint (`POST /api/sessions` already exists for Dispatch; `POST /api/assignments/:id/requeue`, `POST /api/assignments/:id/handoff`, `POST /api/assignments/:id/abandon` for the other three) inserts the `principal.curation` event after the state-machine action commits, via a new helper `createPrincipalCurationEvent(db, sessionId, payload)` in `src/mission-control/db/events.ts` — sibling of the existing `createPrincipalInputEvent` (`events.ts:194`) and `createPermissionRequestEvent` (`events.ts:213`).

**Session id resolution for events.** Events are keyed by `session_id` (FK), not assignment_id. F-12's three curation verbs all act on existing assignments with at least one session: Requeue, Hand-off-from-in-flight, and Abandon-the-assignment use the latest session via `findLatestSessionForAssignment(db, assignmentId)`. For Dispatch on a terminal-state assignment, the event lands on the **new** session created by the spawn. For Abandon-the-task on a task whose assignments are all terminal, the event lands on the latest terminal session via the same helper (the FK is to `sessions(id)`, not to "active session" — `schema.ts:86` enforces only existence, not liveness; `local.process.controlled` sessions persist after `ended_at` is set). Every F-12 curation event therefore has a real session anchor.

**Assignment-less curation events deferred to F-12b.** The earlier draft of this addendum proposed a synthetic per-task `task-shadow-{taskId}` session row to receive Abandon-the-task events on tasks with **zero** assignments. That path is unreachable in F-12 alone (Decision 2 confirms zero-assignment tasks today only arise via the F-12b GitHub-import flow — `POST /api/sessions` always spawns, so every F-12-era task has at least one session). Building the shadow-session helper, the `local.observed` insertion path, and the assignment-less curation event shape inside F-12 would ship dead scaffolding with no producer. F-12b's addendum revisits this when the empty-assignment task-creation path lands and the helper has a real call site. Until then, F-12 has no orphan-event case to handle.

**WS broadcast.** Each `principal.curation` event flows through `broadcastEvent` (`notifications.ts:43`) to connected dashboard clients. The drill-down's event log adds a render block keyed on `payload.kind` rendering one of four one-line summaries:

- `dispatch` → `"Dispatched to {agentName} — {reason || '(no reason)'}"`
- `requeue` → `"Requeued — {reason || '(no reason)'}"`
- `handoff` → `"Handed off from {fromAgentName} to {toAgentName} — {reason || '(no reason)'}"`
- `abandon` → `"Abandoned ({targetKind}) — {reason || '(no reason)'}"`

**Principal id on the event.** Schema-wise `events` doesn't carry `principal_id` — it inherits the principal via the assignment → task chain. F-12 doesn't introduce per-event principal id (deferred to Tier 2 multi-principal runtime per §10). The `principal.curation` event is implicitly attributable to the single principal on Tier 1.

**Why not four separate event types.** Four event types implies four render branches and four migration paths if the shape ever changes. One type with a kind discriminator scales to a fifth verb (e.g. F-12b's "create task from GitHub issue" → `kind: "import"`) by adding a payload variant, not a new type.

## Decision 10 — Scope OUT: explicit deferrals so the PR review stays tight

Things F-12 tempts the implementer to add but that ship in separate PRs (or never):

- **Add-to-queue from a GitHub issue (F-12b).** Decision 1 — separate PR, separate addendum, same Phase E iteration-tracker bullet.
- **Custom task templates / saved presets.** Principals may want *"every test-failure task gets dispatched to the rev agent with priority P1 and a 30-minute budget"* as a preset. Genuinely useful. Out of scope. Templates require a `task_templates` table, a CRUD UI for templates, and a binding between a source-event (e.g. CI failure) and a template — every component is its own design exercise. F-12 ships per-task hand-curation; templates are post-Tier-2.
- **Task dependencies / `blocked_by_task_id`.** Schema reserves room for this (per `docs/design-mission-control.md` §10's table); F-12 does not surface or honour the column. Auto-wake when a dependency clears is out of scope. Principal manages dependencies by hand: Abandon the dependent if its blocker is wrong, Requeue once the blocker clears.
- **Bulk curation ("Abandon all of P3", "Requeue everything that failed in the last hour").** F-12's verbs are per-assignment. Bulk operations are a multiplier on blast radius and need their own UI affordance (multi-select on the F-8 task table, batched-confirm flow, partial-success handling). Out of scope. Principals with ten failed assignments hit Requeue ten times.
- **Cross-repo task linking.** A task on one repo's funnel may relate to a task on another's. The schema's `related_refs_json` already supports display-only linking for any source system (`schema.ts:30`). F-12 does not surface or edit this column. Principals who want cross-references add them by hand to `related_refs_json`; rendering is also out of scope until F-12b reads the field for display.
- **Discord slash commands (`/grove dispatch`, `/grove abandon`).** Same reasoning F-11 used (Decision 10 of `docs/design-mc-f11-discord-notifications.md`) — slash commands are a new ingestion surface with its own auth-and-component story. Out of scope. The existing `~/bin/discord` CLI handles outbound team updates; inbound slash-commands are post-v2.
- **Task comments / discussion thread.** Principals may want a free-form comment per task ("paused this until upstream lib fixes the race"). The existing F-7 drill-down's input affordance (F-10) already lands principal-authored text in `principal.input` events — principals can use it as a comment surface today by typing into a paused/queued assignment's input. A dedicated comment column on `tasks` is out of scope.
- **Task tagging / labels.** GitHub-style labels on tasks would be a useful filter axis. Out of scope. v1 priority + state filters cover the active principal's working set; tagging is a post-Tier-2 expansion alongside multi-principal.
- **Reassign-without-cancel (true mid-flight handoff).** Decision 6 chose cancel-and-respawn to keep the session lifecycle honest. A future "live agent swap" — where the new agent picks up the same session with full context — needs CC stream-json features that don't exist today (cross-agent session import). Out of scope; flagged here so reviewers don't ask.
- **Per-principal curation history view.** "Show me everything I curated today" — useful for retro / audit but additive over the F-7 drill-down per-assignment view. Out of scope. The `principal.curation` events are queryable from the DB if anyone needs them.
- **Auto-dispatch policy on requeue.** Decision 7 leaves `Requeue` ending in `queued` state. A post-Phase-E F-13-dispatcher integration could auto-pick-up requeued assignments. Out of scope for F-12 — that's an F-13 concern.
- **Confirmation dialog for Dispatch.** Decision 8 explicitly skips it (additive verb, low blast radius). If principals report pebcak Dispatches in practice, this is a one-line UI change post-merge — but no speculative gating in v1.

## Decision 11 — Process kill on `cancelled` transitions: a new `state.transition` observer

Decisions 5, 6, and 7 all assume a side effect that the existing process-manager plumbing does **not** provide: closing the live CC subprocess when an assignment moves into `cancelled` (or out of `running`/`blocked`/`dispatched` for Requeue's "blocked → queued" path). Source today only kills processes from two paths — `endpoint.close()` (`src/mission-control/session/endpoint-resolver.ts:239-291`), invoked exclusively from `ProcessManager.closeAll()` on server shutdown (`src/mission-control/session/process-manager.ts:65-144`), and `proc.exited.then(...)` (`endpoint-resolver.ts:170-188`), which runs *after* a process has already exited on its own. Neither is triggered by `applyTransition`.

Without an explicit kill, the F-12 verbs misbehave in the obvious ways:

- **Abandon on `running`** flips `agent_task_assignment.state` to `cancelled` while the CC subprocess keeps running, keeps emitting `stream-json.assistant` events into the dispatcher, keeps spending tokens. The dashboard renders a cancelled assignment that is still producing output — a coherence break principals would file as a bug within a day.
- **In-flight Hand-off** commits the cancel of the source assignment, spawns the new one, and leaves two concurrent CC processes on the same `task_id` racing each other for state.
- **Requeue from `blocked`** moves the assignment back to `queued`, but `findActiveSession(db, assignmentId)` (`endpoint-resolver.ts:96`) still returns the live blocked session. The next Dispatch on that assignment either hits the idempotency path and silently reuses the stale session, or — if the managed process has been removed from the map but the DB row hasn't been ended — throws `SessionConflict` (`endpoint-resolver.ts:109`) on the principal's "fresh run" intent.

**Resolution: introduce a `state.transition` observer.** F-12 wires a single observer in `src/mission-control/notifications.ts` (or a sibling `session/transition-observer.ts` if `notifications.ts` is kept narrow) that runs **after** `broadcastTransition` for any `state.transition` event whose `payload.to` is `cancelled`, **or** whose `payload.action` is `principal_requeue` and `payload.from` is `blocked` (the only requeue path with a live process — `failed → queued` requeue has no live session by definition; `failed` is a terminal state the dispatcher reached via `result` ingestion, which already runs the `proc.exited` cleanup). On those transitions, the observer:

1. Looks up the live endpoint via `processManager.get(sessionId)`.
2. If a managed process exists and is alive (`exitCode === null` and not `closing`), calls `endpoint.close()` on it via the same `createControlledEndpoint` shape `closeAll` uses.
3. If no managed process exists (already exited), does nothing — `proc.exited.then(...)` already handled DB cleanup.

The observer is wired alongside the existing `broadcastTransition` call inside `applyTransition`'s plumbing, so every state transition that crosses into `cancelled` (or out of `blocked` via `principal_requeue`) gets the kill. **F-12 introduces this as new code** — one new file or one new function plus the wiring point. The earlier draft's claim that *"F-12 does not introduce new session-cleanup code"* was wrong; this addendum supersedes it.

**Atomicity.** The kill is necessarily out-of-transaction (it forks a SIGTERM/SIGKILL plus an `await proc.exited`). The DB transition has already committed by the time the observer fires. If the kill itself fails (e.g. the child has already crashed and the race between "is alive" and "send SIGTERM" goes the wrong way), the existing `process.stderr.write` paths in `endpoint.close()` (`endpoint-resolver.ts:250,267`) and the `proc.exited.then` cleanup catch the rejection. The DB state is the source of truth; the kill is a best-effort enforcement on top.

**Why an observer and not inline `endpoint.close()` calls in each handler.** Three handlers (`handleAbandonAssignment`, `handleHandoffAssignment`, `handleRequeueAssignment`) each issue a state-machine `cancel` (or `principal_requeue`); inline-closing in each would triplicate the same pattern, and any future verb that produces a `→ cancelled` transition (e.g. F-13's auto-cancel-on-budget-exhausted) would have to remember to add the same call. An observer on the existing `state.transition` plumbing centralises the policy — same justification §3.3 used for keeping the state machine single-sourced.

**Why not gate Decisions 5/6/7 to "session already dead" states (Option B from the review).** That option scopes Requeue to `failed → queued` only, drops Abandon/Hand-off on `running`/`blocked`, and ships a markedly weaker UX — exactly the principal pain (cancel-while-running, hand-off-while-blocked) F-12 set out to fix. The added cost of Option A (this decision) is one observer file plus its test. The capability uplift is the entire point of the verb set. Option A wins.

**Test coverage.** A new `curation-process-kill.test.ts` covers: (a) Abandon on a `running` assignment kills the process within the test's timeout, (b) Hand-off on `running` kills the source process before the new one spawns, (c) Requeue from `blocked` kills the blocked process, (d) Requeue from `failed` does NOT attempt to kill (no managed process exists), (e) the kill is best-effort — a process that has already exited doesn't cause the observer to throw.

## Scope summary — what F-12 SHIPS

- Three new endpoints in `src/mission-control/api/handlers.ts`:
  - `POST /api/assignments/:id/requeue` — calls `applyTransition(... principal_requeue)` + emits `principal.curation` event with `kind: "requeue"`.
  - `POST /api/assignments/:id/abandon` — body `{ scope?: "assignment" | "task"; reason?: string }`. When `scope === "assignment"` (default if assignment is non-terminal), calls `applyTransition(... cancel)`. When `scope === "task"` (default if assignment is terminal or absent), updates `tasks.status = 'cancelled'`. Emits `principal.curation` event with `kind: "abandon"`.
  - `POST /api/assignments/:id/handoff` — body `{ newAgentId: string; reason?: string }`. Cancels the current assignment (if non-terminal) via `applyTransition`, creates a new `agent_task_assignment` row, spawns a controlled session via existing `spawnControlledSession`. Emits `principal.curation` event with `kind: "handoff"`.
- Existing endpoint `POST /api/sessions` is the Dispatch backing — no changes to its surface; the dashboard wires the existing endpoint into the new `[Dispatch]` button. One new `principal.curation` event with `kind: "dispatch"` is inserted alongside the existing `state.transition` events the spawn already produces.
- New helper `createPrincipalCurationEvent(db, sessionId, payload)` in `src/mission-control/db/events.ts` — sibling of `createPrincipalInputEvent` and `createPermissionRequestEvent`.
- New `state.transition` observer (Decision 11) that calls `endpoint.close()` on transitions into `cancelled` and on `principal_requeue` from `blocked`. Wired alongside the existing `broadcastTransition` call so every curation verb gets the kill side effect for free.
- Dashboard changes in `src/mission-control/dashboard/index.html`:
  - New `.curation-toolbar` block inside `#drill`, immediately above `.drill-input`.
  - Four buttons (Dispatch split, Requeue, Hand off split, Abandon) wired per Decision 3's enablement matrix.
  - Inline confirm panel for Abandon and Hand off (Decision 8).
  - New render branch for `principal.curation` events in the F-7 event log (Decision 9's four one-line summaries).
- Tests in `src/mission-control/__tests__/`:
  - `curation-endpoints.test.ts` — covers the three new endpoints' happy paths and the per-state enablement matrix's wire-side equivalents (e.g., `POST /requeue` on a `running` assignment returns 409 with the state-machine's error string, not 500).
  - `curation-events.test.ts` — covers `createPrincipalCurationEvent` insertion and `findLatestSessionForAssignment` resolution against an existing terminal session.
  - `curation-process-kill.test.ts` — Decision 11's observer; covers Abandon/Hand-off/Requeue process-kill side effects per the test list in that decision.
  - `dashboard-curation-toolbar.test.ts` (browser-side, against the existing dashboard test harness if present, else a `happy-dom` setup) — covers the Decision 3 enablement matrix as a pure DOM-state function.
- Forward-link from `docs/design-mission-control.md` §3.4 (and the §9 Phase E bullet) to this addendum.
- Iteration tracker bullet updated to point at this addendum and to call out the F-12 / F-12b split.

## Scope summary — what F-12 DEFERS

- Add-to-queue from GitHub issue → F-12b (Decision 1).
- **Empty-assignment task UX (stripped-down drill-down at `dashboard/index.html:2134`)** → F-12b (Decisions 2, 3). F-12 alone has no producer for zero-assignment tasks, so the F-8 error pill stays in place until F-12b lands the GitHub-import path AND the matching `POST /api/tasks/:taskId/abandon` endpoint together.
- **Empty-assignment Dispatch wire path** → F-12b (Decision 4). Same reason as above.
- **Empty-assignment Abandon (`POST /api/tasks/:taskId/abandon`)** → F-12b (Decisions 3, 5). The abandon-the-task row in Decision 3's matrix exists only as a marker; F-12 keeps the assignment-keyed surface, F-12b lands the task-keyed sibling.
- **Synthetic `task-shadow-{taskId}` session helper** → F-12b (Decision 9). The orphan-event case it was designed to handle has no producer in F-12.
- Bulk curation, task templates, dependencies, tagging, comments → never (Decision 10).
- Slash-command shortcuts → post-v2 (Decision 10).
- Live-agent swap without cancel → unbuildable today (Decision 10).
- Auto-dispatch on Requeue → F-13 dispatcher concern (Decisions 7, 10).
- Per-principal history view → post-Tier-2 (Decision 10).
- Confirmation dialog on Dispatch → revisit if principals report mistakes (Decision 10).

## Acceptance criteria

- [ ] `POST /api/assignments/:id/requeue` issues `principal_requeue` and returns 200 from `blocked` and `failed`; returns 409 with the state-machine error from any other state.
- [ ] `POST /api/assignments/:id/abandon` with `scope: "assignment"` cancels the assignment via `applyTransition(... cancel)` and clears `block_reason`. With `scope: "task"`, updates `tasks.status = 'cancelled'`. Defaults the scope per Decision 5's rule (active assignment present → assignment, else task).
- [ ] `POST /api/assignments/:id/handoff` cancels the current assignment (when non-terminal), creates a new `agent_task_assignment` row to `newAgentId`, and spawns a controlled session. Returns `{ newAssignmentId, newSessionId }`. Returns 400 if `newAgentId` is missing or unknown.
- [ ] Each curation endpoint inserts an `principal.curation` event with the Decision 9 payload shape and broadcasts it via `broadcastEvent`.
- [ ] The dashboard curation toolbar renders inside `#drill` with per-state button enablement matching Decision 3 exactly.
- [ ] Disabled buttons render with tooltips explaining the blocked verb.
- [ ] Abandon and Hand-off open an inline confirm panel with optional reason; Dispatch and Requeue do not.
- [ ] The F-7 drill-down event log renders one of four one-line summaries for `principal.curation` events per Decision 9.
- [ ] A `state.transition` observer (Decision 11) closes the live CC subprocess via `endpoint.close()` whenever an assignment transitions into `cancelled`, or when `principal_requeue` fires from `blocked`. Verified by `curation-process-kill.test.ts`.
- [ ] All existing mission-control tests still pass; new tests for endpoints, events, the process-kill observer, and toolbar enablement ship green.
- [ ] No new schema migrations. No changes to `state-machine.ts`. No changes to `transitions.ts`. No changes to `tasks.status` enum.

## Where this goes

- New endpoint handlers in `src/mission-control/api/handlers.ts`:
  - `handleRequeueAssignment(db, deps, assignmentId)` — backs `POST /api/assignments/:id/requeue`.
  - `handleAbandonAssignment(db, deps, assignmentId, rawBody)` — backs `POST /api/assignments/:id/abandon`.
  - `handleHandoffAssignment(db, deps, assignmentId, rawBody)` — backs `POST /api/assignments/:id/handoff`.
- Route wiring in `src/mission-control/server.ts` — three new route entries alongside the existing `POST /api/sessions` and `POST /api/assignments/:id/input`.
- Type additions in `src/mission-control/api/types.ts` — `RequeueRequest/Response`, `AbandonRequest/Response`, `HandoffRequest/Response`.
- New helper `createPrincipalCurationEvent` in `src/mission-control/db/events.ts`.
- New `state.transition` observer (Decision 11) — either as a new function in `src/mission-control/notifications.ts` (alongside `broadcastTransition`) or as a sibling `src/mission-control/session/transition-observer.ts` if `notifications.ts` is kept narrow. Wired into the `applyTransition` plumbing point.
- Dashboard edits in `src/mission-control/dashboard/index.html`:
  - New `.curation-toolbar` block + CSS.
  - New render block for `principal.curation` events in the event log.
- Tests:
  - `src/mission-control/__tests__/curation-endpoints.test.ts` (new).
  - `src/mission-control/__tests__/curation-events.test.ts` (new).
  - `src/mission-control/__tests__/curation-process-kill.test.ts` (new) — Decision 11's observer.
  - `src/mission-control/__tests__/dashboard-curation-toolbar.test.ts` (new, if a dashboard-side test harness exists; otherwise the matrix is unit-tested as a pure function exported from a small `curation-toolbar-state.ts` helper).
- No schema changes. No new tables. No new WS message types — `state.transition` and the existing event-broadcast frame carry everything.

Forward-links from `docs/design-mission-control.md` §3.4 and §9 Phase E added in the same PR that lands this addendum. The Phase E iteration-tracker bullet is updated to call out the F-12 / F-12b split and to point at this addendum.
