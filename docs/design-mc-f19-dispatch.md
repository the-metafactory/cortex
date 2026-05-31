# F-19 — Dispatch from task table / iteration kanban (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f19-dispatch.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §2 (Core principal flow), §6.1 (Transport — controlled endpoint), §7.5 (Components).
**Date:** 2026-04-27.
**Status:** Decided. Closes the loop primitive that turns the dashboard from a static viewer into the principal's cockpit.

## Why this addendum

After F-13 → F-18 landed and MC v2 had a real running instance, the principal opened http://localhost:8767/ and saw an empty dashboard despite the day-one plumbing being end-to-end. Tracing the wiring against the spec showed the gap is **not** a backend defect — `POST /api/sessions` already spawns a fully controlled CC subprocess via `endpoint-resolver.ts:spawnControlledSession`, drives the state machine `queued → dispatched → running`, and pipes events back via stream-json + WebSocket. The defect is the **principal surface**: there is no UI affordance to invoke that primitive from the dashboard. A curated task sits on the table; the principal has nowhere to click to make Luna pick it up.

F-19 ships that affordance. After this lands, the §2 principal loop becomes operable end-to-end on a single machine: open the dashboard → curate a task → click Dispatch → watch Luna start running → drill into the attention view if she blocks → type into the input affordance to unblock. Maestro semantics in the browser, exactly as §6.1 intends.

## Decision 1 — Dispatch is a row-level action, not a global one

Two surfaces get a `Dispatch` button:

1. **Task table row** (F-8). Each task with no active assignment shows a `Dispatch` button at the right edge of the row, next to the existing actions. Clicking it opens a tiny inline confirmation popover (`Dispatch this task to Luna?`) with `Confirm` / `Cancel`, then fires `POST /api/sessions { taskId }` (per Decision 3). The row's `aggregate_state` flips from `null` to `queued` on success, the working grid lights up the agent, the task's row inflates to show the live agent chip.

2. **Iteration kanban card** (F-14, when the iteration is in `in_flight`). Each task attached to an iteration in the In-flight column shows a small `Dispatch` chip on the card. Same call shape as the table action.

**Why row-level rather than a global "Dispatch next" button:** the principal's mental model from §3.4 (the funnel) is "I curated this specific thing, now I'm choosing to spend an agent on it." A global "Dispatch next" implies an autonomous priority pull, which is the Paperclip pattern this spec deliberately doesn't adopt for v1 (§7.6, deferred to F-21+ heartbeat-mode).

## Decision 2 — Default agent per Phase E

Until the principal-specified agent picker lands (Phase E in the parent spec), `agentId` is omitted from the request and the existing `ensureDefaultAgent` path in `handleCreateSession` takes over (`api/handlers.ts:512`). That gives every dispatched session the same well-known default head — fine for v1 single-principal. The popover names the agent ("Dispatch this task to Default Agent?") so the principal isn't surprised when the working grid shows an unfamiliar identity.

The agent picker is F-19's natural follow-up (call it F-19.1) but ships as a separate PR — a button vs. a multi-agent selector are clean diff boundaries.

## Decision 3 — Request payload is `{ taskId }`, nothing more

The existing `POST /api/sessions` payload accepts `{ taskId?, title?, prompt?, agentId?, principalId? }`. F-19 always passes `taskId` (we have one). The server's existing branch in `handleCreateSession:547` skips the task-create path when `taskId` is set, so `title` would be **dead data** on this code path — there is no request audit-log surface that would consume it (the only audit trail is the rows in `tasks` / `agent_task_assignment`, and the `tasks` insert is exactly the path skipped). Drop it. `agentId` and `principalId` are also omitted — `ensureDefaultAgent` and `DEFAULT_PRINCIPAL_ID` cover them per Decision 2. `prompt` stays unset — the default-agent persona file owns the boot prompt; sending an empty principal turn would log a no-op `principal.input` event. Final payload: `{ taskId }`.

## Decision 4 — Optimistic UI with rollback on 4xx/5xx

Mirrors the F-15 mutation pattern:

1. Click → button shows a spinner immediately.
2. Optimistic UI: row's local `aggregate_state` flips to `queued`, table re-sorts.
3. POST /api/sessions.
4. On 2xx: refetch tasks (the server's WS broadcast will also propagate).
5. On **409 with an `existingAssignmentId`** (Decision 5's debounce hit): treat as success — the *other* tab already dispatched. Refetch instead of rolling back; no toast (the WS broadcast surfaces the new agent the same way).
6. On other 4xx/5xx: revert local state, surface a toast with the server-provided `error` body.

Why optimistic: the dispatch round-trip includes spawning a CC subprocess, which is ~200-400ms even on a warm box. Snapping the UI gives the principal the responsiveness the cockpit framing demands. The 409-as-success branch prevents a visible flicker + misleading "dispatch failed" toast when two tabs race — per Echo's PR #54 cycle-2 review.

## Decision 5 — Concurrency + idempotency

Single-tab two-click protection: the button is disabled while the request is in flight. If the principal double-clicks before the request returns, only the first POST fires. A second click on the same task **after** the first succeeds is gated by the row's `aggregate_state` — a task with an active assignment doesn't render a Dispatch button.

**Cross-tab protection: 2-second server-side debounce on `(taskId, agentId)`.** Each parallel-tab POST today calls `spawnControlledSession` (`handlers.ts:574`), which means a `Bun.spawn` of a fresh CC subprocess per request and real Anthropic billing for what the principal experienced as one click. UI-side gating doesn't help — the second tab doesn't see the first tab's state. F-19 ships a small in-memory `Map<taskId+agentId, expiry>` debounce in `handleCreateSession`: if a `(taskId, agentId)` POST arrives within 2 seconds of a successful one, return `409` with the existing assignment id. Memory-only (cleared on restart); 2 seconds is far longer than any human double-click round-trip and far shorter than the legitimate "second principal dispatched the same task on purpose" interval. Per Echo's PR #54 review — token cost of duplicate dispatches dominates the state-correctness framing.

## Decision 6 — REST contract is unchanged; one tiny handler-internal addition

The wire shape of `POST /api/sessions` doesn't change — same request fields, same response, same status codes (with one new 409 path: the cross-tab debounce from Decision 5). No new endpoints, no schema migrations, no event-shape changes. The 2-second `(taskId, agentId)` debounce lives entirely inside `handleCreateSession` as an in-memory map.

That keeps the PR small: one frontend component + two row-action wirings + ~15 lines of debounce in the existing handler + a debounce-path test. Rollback = revert the commit.

## UI shape

```
┌─────────────────────────────── Tasks ─────────────────────────────────┐
│ P  Title              Iteration  Agents  State  Age      Actions     │
│ P0 Fix HMAC bug       —          —       —      2h       [Dispatch]  │
│ P1 Refactor router    G-204      Luna ●  running 12m     —           │
│ P2 Bump grove-bot     —          —       —      4h       [Dispatch]  │
└─────────────────────────────────────────────────────────────────────────┘
```

Click `[Dispatch]` → small popover anchored under the button:

```
┌────────────────────────────────┐
│ Dispatch this task to          │
│ Default Agent?                 │
│                                │
│ [Cancel]      [Confirm ↵]      │
└────────────────────────────────┘
```

Enter confirms; Esc cancels. Keyboard-first matches the cockpit framing.

## Open questions

- **Q1 — Task-without-iteration UX.** Some tasks live outside iterations (loose work). Dispatch button on those is unambiguous. For tasks attached to iterations, do we restrict dispatch to the iteration's `in_flight` column only (forcing the principal to advance the iteration first), or allow it from any column? **Decided: allow from any column.** The kanban controls the planning lifecycle, not the dispatch gate. An iteration can have a single task dispatched ahead of the rest; the kanban shows that as a working agent chip on the card.

- **Q2 — What if the default agent is already busy?** v1 default agent is a single shared head. If a previous dispatch is still running, the new dispatch creates a second assignment on a different task — both `running` simultaneously under the same agent identity. The working grid renders one agent card with multiple active assignments. F-9 already supports this. Not a v1 blocker.

- **Q3 — Should Dispatch require a principal confirmation or be one-click?** **Confirmation popover** chosen. Spawning a CC subprocess is non-trivial work and the principal is paying for tokens; one keystroke confirmation prevents fat-finger dispatches. Returns to the cockpit pattern of "deliberate principal action over autonomous execution."

## Deferred to F-19.1+

- F-19.1 — Principal agent picker (replace default-agent with a dropdown of registered heads when more than one head exists).
- F-19.2 — Dispatch with custom prompt (principal types a one-line "what should the agent focus on" before confirming).
- F-19.3 — Bulk dispatch from kanban column (select multiple cards, dispatch all).
- F-19.4 — Re-dispatch on terminal-state task (the "do this again" pattern after a `failed` or `cancelled` assignment).
