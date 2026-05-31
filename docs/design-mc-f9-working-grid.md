# F-9 — Working-agent grid (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f9-working-grid.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §8.1 position ② and §8.3 (Working agents — grid below the focus area).
**Date:** 2026-04-24.
**Status:** Decided. Resolves the open questions enumerated below before F-9 implementation begins.

## Why this addendum

§8.3 is a three-sentence specification: *"Working-but-not-blocked agents render in the grid below. State-machine indicators, no attention prompts. Clicking a grid tile opens the attention view (§5) — same primitive, different entry point."* That leaves the concrete shape (tile granularity, which states count as "working", endpoint, layout, empty state, interaction with F-6/F-7/F-8) to implementation time. F-6, F-7, and F-8 each shipped with a pre-implementation addendum; F-9 follows the same discipline so code review can focus on code against decided criteria.

## Decision 1 — Tiles are agent-keyed, not assignment-keyed

An agent can hold multiple active assignments (rare today, common once Phase E's curation UX lands). The alternatives:

- **Agent-keyed** (one tile per agent): renders the agent's *current primary* assignment inline; a small numeric badge shows additional active assignments.
- **Assignment-keyed** (one tile per running assignment): simpler to map to data but produces duplicate agent tiles that are visually confusing when Luna has three running heads.

**Choice: agent-keyed.** The dashboard's mental model (§2, §5) is "which agent is doing what" — one mental row per agent. Assignment-keyed tiles optimise for rows in a data table, not for at-a-glance fleet health. §8.1's illustration reinforces this: the grid shows `Luna` once, next to `Lu` (idle instance), `impl`, `rev`, `rp` — each is one agent, not one assignment.

**"Current primary" assignment rule** (same rank numbers as F-8 Decision 4; only ranks 1–3 are reachable here because Decision 2 filters out `blocked` and every terminal state before this rule runs):

```
running > dispatched > queued
```

Ties broken by the most recent `updated_at`, mirroring F-8's primary-active rule so the F-7 drill-down entry-point semantics stay consistent between table row click (F-8) and grid tile click (F-9). Rank numbers (`running=1, dispatched=2, queued=3`) are kept identical to F-8's table so the two projections share one canonical rank vocabulary; F-8's `blocked=0` and `failed/completed/cancelled=4..6` slots exist but are unreachable in F-9's output.

## Decision 2 — "Working" = any active assignment state EXCEPT `blocked`

The spec says "working-but-not-blocked". Concretely, the set of states that land an agent on the grid:

| State | In grid? | Why |
|---|---|---|
| `running` | ✅ | Actively producing work — the canonical "working" signal |
| `dispatched` | ✅ | Accepted, about to run — still holding a slot, still "working" from principal's perspective |
| `queued` | ✅ | Waiting to start but already assigned — Luna is "working on" this even if nothing is moving yet |
| `blocked` | ❌ | Already surfaced in F-6 focus area; double-surfacing fragments attention |
| `completed` / `failed` / `cancelled` | ❌ | Terminal; no ongoing work |

**Rule.** An agent appears in the working grid iff the agent has **at least one active assignment** where state ∈ `{running, dispatched, queued}`. Agents with only `blocked` assignments are excluded (they're in the focus row). Agents with only terminal assignments are excluded. Agents with **no** assignments at all are excluded.

**Interaction with F-6 / F-8.** An agent can legitimately appear in BOTH the focus row (if they have a blocked assignment) AND the working grid (if they *also* have a running assignment for a different task). That's correct — it's the same agent juggling two tasks, one needing attention and one making progress. The duplication here is **information**, not redundancy.

## Decision 3 — Idle persistent agents are NOT in F-9

An agent configured as `persistent = 1` (see `agents.persistent`) is long-lived and may sit idle between tasks. Should idle persistent agents render in the grid?

**No, not in F-9.** The grid is "who is working". An idle agent is surfaced elsewhere (the task table, post-F-12 Phase E once dispatch UX exists). Showing idle tiles alongside working tiles dilutes the signal and forces a second visual pass to find what's actually moving.

A future iteration may add a collapsed "idle pool" row — explicitly deferred to post-Phase-B.

## Decision 4 — New endpoint: `GET /api/working-agents`

F-9 needs an agent-keyed projection with the "current primary" assignment folded in. Alternatives considered:

1. **Derive on the client from `GET /api/assignments`.** Requires client-side grouping per tick plus a separate agents fetch for idle-not-working tiles (which we excluded by Decision 3). The grouping logic would duplicate the server's rank table, which we already own as a source of truth after F-8.
2. **Derive on the client from `GET /api/tasks`.** Task-keyed the wrong way — grouping by agent would scan all tasks × their assignments. Fine at Phase B scale but wrong-shaped.
3. **New task-keyed endpoint.** Matches the F-6 (`/api/focus-area`) and F-8 (`/api/tasks`) precedent — server owns the projection, client renders it.

**Choice: (3).** Consistent with the pattern. No client-side rank logic.

```
GET /api/working-agents

200 { agents: WorkingAgentTile[] }
```

**WorkingAgentTile shape:**

```ts
interface WorkingAgentTile {
  agent_id: string;
  agent_name: string;
  agent_type: 'head' | 'hands';
  /**
   * Tile sort key — same rank numbers as F-8 Decision 4 (lower = more active).
   * Only values 1..3 appear because `blocked` (0) is filtered out, and
   * terminal states (4..6) are excluded from the grid entirely.
   */
  primary_state_rank: 1 | 2 | 3;
  primary_state: 'running' | 'dispatched' | 'queued';
  /**
   * Current primary assignment surfaced on the tile (Decision 1).
   * Always non-null for rows returned by this endpoint — an agent with
   * zero active-non-blocked assignments does not appear at all.
   */
  primary_assignment: {
    id: string;
    task_id: string;
    task_title: string;
    task_priority: number;
    updated_at: string;            // ISO-8601 UTC
  };
  /**
   * Count of additional active-non-blocked assignments beyond the primary.
   * 0 for the common case; drives the "+N" badge rendering.
   * Excludes blocked and terminal states for consistency with Decision 2.
   */
  additional_active_count: number;
}
```

**Sort:** server returns rows ordered by `primary_state_rank ASC, primary_assignment.updated_at DESC`. Most-active agents first. Client does not re-sort in v1 — the grid is small enough that principal ordering is not a felt need.

**No filters, no pagination.** The grid is a fixed visual surface. If a future iteration needs filtering ("show only heads"), it composes cleanly on top. The natural bound on the result set is `COUNT(DISTINCT agent_id)` in `agent_task_assignment` filtered by `state IN ('running','dispatched','queued')` — tiny in Phase B (single-digit to low-tens). No explicit `LIMIT` is needed in v1; if operational reality pushes that bound up a couple of orders of magnitude, the cap gets sized against the agent denominator (not copied from F-8's task denominator, which caps a different thing).

**Index.** `idx_ata_state` covers the state filter (`state IN ('running','dispatched','queued')`); the per-agent `GROUP BY` that picks the current primary is a small in-memory hash aggregation given Phase B fleet size, not an index-backed operation. Called out so a future reviewer doesn't propose an unneeded `(agent_id, state)` composite to "cover the GROUP BY" — it isn't worth the write cost at this scale.

## Decision 5 — Tile layout: 160 px × 80 px, CSS grid auto-fill

```
┌──────────────┐
│ agent_name   │  ← primary text, 13 px, weight 500
│ task_title   │  ← secondary, 12 px, text-dim, line-clamp 2
│ P0 · running │  ← meta row, 11 px, mono
└──────────────┘
```

- Fixed tile dimensions so the grid wraps predictably. `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`.
- Tiles carry the same priority left-border accent as F-6 focus cards (P0 red, P1 amber, P2 muted, P3 dashed) so fleet-health scanning stays color-consistent with the focus row.
- State label colour mirrors F-8's aggregate-state pill (accent blue for running, muted for queued/dispatched) — the principal's visual vocabulary is already trained.
- `+N` badge (Decision 1's "additional active count") renders as a small chip in the top-right of the tile when `additional_active_count > 0`. Clicking it does **not** drill in F-9 — see Decision 6.

**Empty state** — see Decision 7.

## Decision 6 — Tile click opens F-7 drill-down on the primary assignment; `+N` badge is inert

Consistent with F-8 Decision 5: the drill-down entry point is singular. `+N` badge is not a selector for a specific non-primary assignment in F-9 (would require a disambiguation popover, which is scope creep). The badge is metadata.

**If the principal wants to drill into the non-primary assignment:** use F-8's task table (each task is its own row) or F-6 if the assignment is blocked. The grid is the at-a-glance view, not a precision entry point.

## Decision 7 — Empty state: single heartbeat line

Two flavours of empty:

| Condition | Copy |
|---|---|
| Endpoint returned `agents: []` and focus row is also empty | "No agents working right now." |
| Endpoint returned `agents: []` and focus row has entries | Hide the grid entirely — showing an empty grid next to a full focus row creates visual confusion about whether the data is stale. |

Note both conditions key off the endpoint-level truth (`agents: []`), not "is every working assignment blocked". An agent with both a `blocked` and a `running` assignment appears in BOTH surfaces per Decision 2's "Interaction with F-6 / F-8" paragraph, so "all working is blocked" is a strict subcase of `agents === []`, not equivalent to it.

**Implementation:** the client shows the "No agents working right now" message when `focusItems.length === 0 && agents.length === 0`, and hides the section entirely when `focusItems.length > 0 && agents.length === 0` (there's attention to give; don't distract with "none working").

No decorative icons; matches the text-forward aesthetic.

## Decision 8 — WS refetch on `state.transition` only

F-9's view depends on which agents have active-non-blocked assignments. Only `state.transition` can change that; nothing else in the WS contract moves an assignment in or out of the qualifying set. Filter to `state.transition` and debounce at 100 ms (same window as F-8, so a burst of transitions triggers a single coordinated refetch across F-6, F-8, and F-9).

**Asymmetry with F-6:** F-6 only re-fetches when `from === 'blocked'` or `to === 'blocked'`. F-9's membership function cares about `{running, dispatched, queued}`, so the minimum-correct filter is *"transitions where `from ∈ {running,dispatched,queued}` OR `to ∈ {running,dispatched,queued}`"* — that covers every membership change (queued→running, running→completed, blocked→running, …) without refetching on pure terminal-to-terminal churn (e.g. a bulk-archive flipping `completed → cancelled`). F-9 v1 keeps the simpler *"every `state.transition`"* trigger — it is a slightly over-broad superset of the strictly-correct filter, chosen for implementation simplicity, and the overhead is negligible at Phase B. Documented here so the implementer doesn't copy F-6's trigger filter by accident, and so a future tightening pass knows the minimum-correct shape — same pattern the F-8 addendum flagged for the task table.

Per-feature debounce timers are not consolidated: F-6 at 150 ms, F-8/F-9 at 100 ms. Acceptable divergence since each feature has its own acceptable staleness threshold. If this ever grows into four+ consumers, collapse to a single `scheduleDashboardRefetch` that fans out — not v1.

## Decision 9 — Grid placement: sibling section between the focus area and the F-8 task table

§8.1's layout puts the grid at position ② — below the focus area, above the task table (position ③). F-8 added the task table as a top-level section after the focus area and before `<main>`. For layout consistency, F-9 uses the same pattern: a top-level `working-grid` section whose DOM position sits between `focus-area` and `tasks-section` (i.e., the F-8 task table), *not* inside `<main>`. Current DOM order is `focus-area` → `tasks-section` → `<main>`; the new order after F-9 is `focus-area` → `working-grid` → `tasks-section` → `<main>`.

The v1 placeholder assignments list inside `<main>` (assignment-keyed debug table) stays untouched — removing it is a Phase C / F-10 concern. F-9 only adds; no reshuffle.

**Keyboard navigation.** F-6 uses `1`–`9` + arrows on the focus row. F-8 uses arrow keys inside the task table when a row is focused. F-9 inherits the same pattern: arrow keys navigate tiles when the grid has focus. `Enter` on a focused tile opens the drill-down. No numeric shortcuts (grid can exceed 9 tiles).

**Global keyboard coexistence.** The F-8 listener already gates on `!drillEl.hidden`; F-9 does the same. `Tab` cycles through the grid tiles after the focus-area cards and before the task-table headers (natural document order). `F` / `/` stay bound to the F-8 filter bar.

## Decision 10 — No grid-level sort or filter UI

§8.3 is deliberately minimal. Adding sort / filter affordances to the grid would push it toward being a second task table, which is redundant with F-8. The grid's job is "at-a-glance" — any query need is the task table's job.

**Explicitly not in F-9:** show-only-heads toggle, group-by-state collapse, keyboard shortcut to jump to most-recently-active. All of those can be additive post-Phase-B.

**No hash state.** F-9 introduces no `location.hash` state — nothing in the grid is persistable (no filters per this decision, no selection per Decision 6, a single canonical server sort per Decision 4). The grid composes cleanly alongside F-8's `#tasks?p=…&age=…&closed=…` filter hash and F-10's future `#a/:id` drill-down hash without needing its own hash slice. Called out explicitly because F-7 (no hash) and F-8 (hash) made opposite choices, and this addendum follows F-7's precedent.

## Scope summary — what F-9 SHIPS

- `GET /api/working-agents` — agent-keyed projection with current-primary assignment + `additional_active_count` (Decisions 1, 2, 4).
- `listWorkingAgents(db)` in a new `src/mission-control/db/working-agents.ts`.
- New `working-grid` section in `dashboard/index.html` below the focus area and above the task table (Decision 9).
- Tile: agent name, task title (2-line clamp), priority accent border, state label, `+N` badge if additional active (Decision 5).
- Tile click opens F-7 drill-down on the current primary assignment (Decision 6); `+N` badge inert.
- Arrow-key tile navigation + Enter opens drill-down when grid has focus (Decision 9).
- Empty-state handling — shown only when focus row is also empty (Decision 7).
- WS `state.transition` debounce-triggers a grid refresh (Decision 8).
- Tests: endpoint filtering + current-primary selection + additional-active-count + rank ordering; tile-click routing unit test; hidden-when-focus-nonempty behaviour.

## Scope summary — what F-9 DEFERS

- Idle persistent agent row (Decision 3).
- `+N` badge as a secondary entry point (Decision 6).
- Grid filter / sort UI (Decision 10).
- Show-only-heads toggle / group-by-state / activity heatmap.
- Grid-to-task-table keyboard teleport (additive, later).

## Acceptance criteria

- [ ] `GET /api/working-agents` returns one row per agent with at least one active-non-blocked assignment; returns `[]` when no such agent exists.
- [ ] Each row carries the current-primary assignment (rank-lowest, `updated_at` tie-broken) and a correct `additional_active_count` of other active-non-blocked assignments.
- [ ] Rows sorted by `primary_state_rank ASC, updated_at DESC`.
- [ ] Working grid renders below the focus area, above the F-8 task table.
- [ ] Each tile renders agent name, task title (2-line clamp), priority border accent, state label, and `+N` badge when applicable.
- [ ] Tile click opens the F-7 drill-down on the primary assignment.
- [ ] `+N` badge is visually present but non-interactive.
- [ ] Arrow-key navigation + Enter works when the grid has focus.
- [ ] Grid is hidden when `focusItems.length > 0` and the working-agents endpoint returned `[]` (all working is blocked).
- [ ] "No agents working right now" copy shows when both grid and focus row are empty.
- [ ] WS `state.transition` triggers a debounced refetch of the grid.
- [ ] All existing mission-control tests still pass; new tests for endpoint + tile selection + empty-state behaviour ship green.

## Where this goes

- New endpoint: `src/mission-control/api/handlers.ts` + route in `server.ts` + types in `api/types.ts`.
- New DB module: `src/mission-control/db/working-agents.ts` (exports `listWorkingAgents`, `WorkingAgentTile`).
- Dashboard: `src/mission-control/dashboard/index.html` — new grid section, tile render, keyboard bindings.
- Tests: `src/mission-control/__tests__/api.test.ts` (endpoint), plus a new `__tests__/working-agents.test.ts` for `listWorkingAgents` + rank / tie-break unit cases.

Forward-link from the main spec §8.3 added in the same PR that lands this addendum.
