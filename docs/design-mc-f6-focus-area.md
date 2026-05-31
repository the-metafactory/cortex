# F-6 — Focus area "who needs me" (design addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f6-focus-area.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Parent spec:** `docs/design-mission-control.md` §8.2.
**Iteration tracker:** `docs/iteration-mission-control.md` Phase B.
**Status:** design (pre-implementation).
**Last updated:** 2026-04-22.

F-6 is the first piece of the Phase B dashboard: the horizontal card row at the top of the page showing the items that need the principal's input, sorted by task priority. This addendum resolves three open questions surfaced during pre-implementation review so the coding feature can ship in one PR without design churn.

---

## 1. Resolved questions

### Q1 — The `principal.input.requested` event type

**Question.** The parent spec §8.2 defines focus-area content as *"blocked assignments, plus any assignment with an `principal.input.requested` event"*. Does any code today emit that event?

**Finding.** No. A repo-wide grep for `principal.input.requested` matches only `docs/design-mission-control.md`. Phase A shipped `permission.request` as a `BlockReason` (hard-block path, in `types.ts`) but no soft-prompt event. `principal.input.requested` is the soft path — the agent says "what do you want me to do next?" without entering the `blocked` state.

**Decision.** F-6 v1 queries **only `state = 'blocked'`**. The soft-prompt path is folded into **F-10** (principal input affordance) where the event is actually emitted. When F-10 lands, the focus-area query extends with a `UNION` against `events.type = 'principal.input.requested'` with an "unresolved" marker. F-6 ships with a TODO comment pointing at F-10 so the extension point is obvious.

**Rationale.** All three Phase A `BlockReason` kinds (`permission.request`, `tool.error`, `review.checkpoint`) drive the assignment to `blocked` state, so "blocked" already covers 100% of today's attention signals. Shipping F-6 against an event that no code emits is pure design debt.

### Q2 — "Time in state" source field

**Question.** The card shows "time in state". Do we need a new `state_entered_at` column, or can we compute it?

**Finding.** `agent_task_assignment.updated_at` is already written by `applyTransition` on every state change. There are three writers of the table — `INSERT` in `handleCreateSession` (initialises `updated_at` at assignment creation), `UPDATE` in `applyTransition` (the only path that mutates `updated_at` after creation), and `DELETE` on spawn-failure rollback. Because `applyTransition` is the **only `UPDATE` path for `updated_at`** and it runs on every state change, `updated_at` is effectively `state_entered_at` today. No schema migration needed.

**Decision.** Use `agent_task_assignment.updated_at` as the time-in-state source for F-6. The `listAssignments` query already returns it. Client formats the delta on render (`3m ago`, `1h 12m ago`).

**Risk (accepted).** If a future writer ever bumps `updated_at` on a non-state-changing edit, "time in state" silently drifts. We accept this because (a) the CHECK constraint means any non-state edit would still have to pair with a valid state/block_reason combo, and (b) if it ever becomes a concern, adding a dedicated column is a pure-additive migration. We document the invariant with a comment at the query site.

### Q3 — Keyboard navigation scope

**Question.** Parent spec §8.2 lists `1`–`9` select, `Enter` drill down, `Esc` back. `Enter`/`Esc` require the attention view (§5) to exist, which is **F-7**'s scope. How much keyboard lands in F-6?

**Decision.** F-6 ships:

- `1`–`9` — select focus-area card by position. Visual selection highlight.
- Arrow keys `←` / `→` — move selection one card.

F-6 **defers** to F-7:

- `Enter` — open attention view (no view to open yet).
- `Esc` — return to focus-area root (no drill-down context to return from).

When F-7 lands, it wires `Enter`/`Esc` against the already-selected card.

---

## 2. Scope for F-6 v1

### What ships

1. **DB query** — **new function `listFocusArea(db): AssignmentListItem[]`** in `src/mission-control/db/assignments.ts`, alongside (not replacing) the existing `listAssignments`. Returns only `state = 'blocked'` rows, ordered by `task.priority ASC` (P0 first), then `updated_at ASC` (oldest-waiting first within a priority lane — matches §8.4's within-lane rule). **Do not modify `listAssignments`:** its current `updated_at DESC` ordering is load-bearing for `GET /api/assignments` and changing it would break the existing placeholder dashboard consumer.
2. **REST endpoint** — `GET /api/focus-area` returns `{ items: AssignmentListItem[] }`. Rationale for a separate endpoint rather than a client-side filter of `/api/assignments`: the query is hot (dashboard polls frequently) and different endpoints keep the server in control of ordering. Phase-B-only; may merge back once the dashboard is stable.

   **Index strategy.** The existing `idx_ata_state` single-column index is sufficient for Phase B: at realistic fleet sizes (≤ dozens of assignments) the `state = 'blocked'` partition is small enough that the follow-on `ORDER BY t.priority, a.updated_at` sort is O(k log k) with k ≪ 100. If profiling ever shows this as hot, the follow-up is a composite `(state, updated_at)` index on `agent_task_assignment` and/or `(priority, updated_at)` on `tasks`. Acknowledging the small-partition argument here so future reviewers aren't re-answering the same question.
3. **WS integration** — the focus-area view re-fetches on `state.transition` broadcasts where `from === 'blocked'` or `to === 'blocked'` (transitions that can change focus-area membership). Events unrelated to block state don't trigger a re-fetch.
4. **Dashboard component** — horizontal card row in `src/mission-control/dashboard/index.html`, replacing or supplementing the current placeholder list. Max 6 cards; if the query returns more, show 6 + a "+N more" tail chip that links to the table view (table view is F-8).
5. **Keyboard navigation** — `1`–`9` and `←`/`→` as specified in §1 Q3.
6. **Empty state** — "All clear" heartbeat with the most-active-agent one-liner (most-active = whichever `running` assignment has the newest event in the last minute, or the newest `updated_at` if none in that window).

### Card fields

Per parent spec §8.2 "Cards (not drill-downs)":

```
┌─────────────────────────┐
│ {agent.name} × {task.id shortened} │    ← header
│ blocked                  │            ← state
│ {block_reason summary}   │            ← one-line "what it needs"
│ P{priority} · {age}      │            ← priority + time-in-state
└─────────────────────────┘
```

Block-reason-to-one-liner mapping:

| `BlockReason.kind`    | One-line summary                                         |
|-----------------------|----------------------------------------------------------|
| `permission.request`  | `approve: {payload.requested_action}` (truncate at 40ch) |
| `tool.error`          | `error: {payload.tool_name}` (truncate at 40ch)          |
| `review.checkpoint`   | `review: {payload.description}` (truncate at 40ch)       |

### Ordering

1. `task.priority` ASC (0, 1, 2 — P0 first).
2. Within the same priority lane, `agent_task_assignment.updated_at` ASC (oldest-waiting first — "longest-waiting surfaces first" from parent §8.4).

**Explicitly not ordered by attention type.** Parent §8.2: *"An error on a P0 task outranks an approval on a P2 task. The attention type … is displayed as metadata on the card but does not drive ordering."*

---

## 3. Out of scope (deferred)

| Deferred to | Item |
|-------------|------|
| F-7         | Attention view drill-down; `Enter`/`Esc` keyboard |
| F-8         | Task table (the "+N more" tail chip links here once it exists; until F-8, the chip is inert) |
| F-9         | Working-agent grid below focus area |
| F-10        | Soft-prompt events (`principal.input.requested`) extending the focus-area query |
| F-11        | Discord notification on blocked-state entry |

---

## 4. Acceptance criteria

F-6 ships when all of the below are true:

- [ ] `GET /api/focus-area` returns a JSON array of focus-area items, ordered by priority then updated_at, filtered to `state = 'blocked'`.
- [ ] Dashboard renders a horizontal card row from that endpoint, with card fields and one-liners per §2 of this doc.
- [ ] Moving an assignment into `blocked` state via `applyTransition` makes a card appear without a page reload (WS-triggered re-fetch).
- [ ] Moving a `blocked` assignment out of that state (complete/fail/principal-requeue) removes the card without a reload.
- [ ] Empty state renders "All clear" + most-active-agent line when no assignments are `blocked`.
- [ ] `1`–`9` select by position; `←`/`→` move selection; selected card has a visual highlight.
- [ ] Happy path and empty state have unit tests; the WS re-fetch trigger has one integration test that drives `block` then `operator_requeue` and asserts two re-renders.
- [ ] When the focus-area query returns more than 6 items, the dashboard renders the first 6 cards plus a "+N more" tail chip. Until F-8 ships, the chip is visually present but inert (no navigation); once F-8 lands, it links to the table view.

---

## 5. Non-decisions (explicitly left to implementer)

- **CSS / visual design.** Cards get *some* colour differentiation so the principal can tell priorities apart, but the specific palette is not specified here. Use what's already in the placeholder dashboard as a starting point.
- **Polling cadence of the fallback refetch timer** (if any). WS is the primary update path; a long-interval polling safety net (30s+) is fine if the implementer wants one.
- **`task.id shortened`** — pick any short form that fits the card width; `T-42` or `#abc123` both acceptable.
