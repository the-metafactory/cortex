# F-8 — Task table (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f8-task-table.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §8.4 (Task table — sortable, filterable) and §8.5 (Task detail == attention drill-down).
**Date:** 2026-04-24.
**Status:** Decided. Resolves the open questions enumerated below before F-8 implementation begins.

## Why this addendum

§8.4 specifies the task table's shape — v1 columns (`priority`, `title`, `agents`, `state`, `age`), v1 sorts (`priority`, `age`), v1 filters (`priority`, `age`) — and §8.5 declares the shared drill-down entry point with F-7. A handful of decisions were left to implementation time: the agents column is a 1-to-N relationship (one task → many assignments), "state worst-case across assignments" needs a concrete aggregation rule, closed tasks need an inclusion policy, and the list endpoint needs a shape. F-6 and F-7 each shipped with a pre-implementation addendum (`docs/design-mc-f6-focus-area.md`, `docs/design-mc-f7-attention-view.md`); F-8 follows the same discipline.

## Decision 1 — New endpoint: `GET /api/tasks`

F-8 needs a list of tasks enriched with their assignment roll-up. The existing `/api/assignments` is assignment-keyed (one row per assignment) and would require client-side grouping to become task-keyed. Rather than push that aggregation to the browser on every refresh, the server returns a task-keyed projection.

```
GET /api/tasks?includeClosed=false

200 { tasks: TaskListItem[] }
```

**TaskListItem shape:**

```ts
interface TaskListItem {
  id: string;
  title: string;
  priority: number;              // 0 (P0) … 3 (P3); ascending = more urgent
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  created_at: string;            // ISO-8601 UTC (hydrated from INTEGER epoch; see note below)
  updated_at: string;            // ISO-8601 UTC (hydrated from INTEGER epoch; see note below)
  source_system: 'github' | 'internal';
  source_ref: string | null;     // `${source_system}:${source_external_id}` if set, else null
  source_url: string | null;     // mirrors tasks.source_url; enables drill-down link-out without re-fetch
  /**
   * Roll-up of all assignments for the task. Empty array when the task has
   * no assignments yet (created but un-dispatched — a Phase E state).
   */
  assignments: Array<{
    id: string;
    agent_id: string;
    agent_name: string;
    state: AssignmentState;
    updated_at: string;          // ISO-8601 UTC (hydrated from TEXT; see note below)
  }>;
  /**
   * Aggregate state for the table's "State" column — see Decision 4.
   * Null when `assignments` is empty.
   */
  aggregate_state: AssignmentState | null;
}
```

**Timestamp hydration note.** `tasks.created_at` and `tasks.updated_at` are stored as `INTEGER NOT NULL DEFAULT (unixepoch())` (epoch seconds), whereas `agent_task_assignment.updated_at` is `TEXT DEFAULT (datetime('now'))`. F-6 already ships `normalizeSqliteDatetime()` in `db/assignments.ts` for the TEXT → ISO-8601 conversion, but that helper treats integers as strings and returns them unchanged. F-8 must add a sibling helper — e.g., `epochSecondsToIso(n: number): string` that returns `new Date(n * 1000).toISOString()` — and apply it to the task row's `created_at`/`updated_at` at the hydrate boundary in `db/tasks.ts`. Assignment rows continue to use `normalizeSqliteDatetime`. Both helpers converge on the same wire contract: `ISO-8601 UTC with 'T' separator and 'Z' suffix`. Include a one-line unit test for each helper in `__tests__/tasks.test.ts` so a future edit that collapses them back into one doesn't silently round-trip an integer through the TEXT path.

**Rationale for keeping ISO-8601 on the wire** (rather than changing `TaskListItem` to `number` epoch seconds): the dashboard already renders ISO-8601 for `AssignmentListItem` timestamps and reusing the same formatter keeps the render code uniform. Integer-epoch timestamps would also lose information (sub-second precision we don't currently use but cost nothing to preserve) and would diverge from F-6/F-7's wire shape.

**Why a separate endpoint** (rather than client-side grouping of `/api/assignments`): task-keyed is the primary view for this page; shipping the aggregation once, on the server, is cheaper than shipping it to every client on every refresh. Matches the F-6 precedent (`/api/focus-area` is a server-side projection of the same underlying data).

**Query param:** `includeClosed` (boolean, default `false`). When omitted/false, the server filters `status NOT IN ('done','cancelled')`. Operators opt in by toggling a checkbox (Decision 6). Rationale: at realistic fleet sizes the backlog of closed tasks will dwarf the active set within weeks. Surfacing all of them by default would drown the P0 row.

**Sort:** server returns rows ordered by `(status IN ('done','cancelled')) ASC, priority ASC, updated_at DESC` as a stable default; the client re-sorts in-memory on column-header click. The leading boolean partition key sinks closed rows to the bottom of the result set regardless of how recent or high-priority they are, which matters once `includeClosed=true` is toggled (see next paragraph). No server-side sort params in v1 — client-side re-sort over a bounded page is faster than round-tripping.

**No pagination in v1.** The Phase B operator working-set is bounded (tens to low hundreds of tasks at most). The server caps the payload at `TASKS_QUERY_LIMIT = 500` — well above any plausible v1 working-set — and a response at that cap is a signal to add pagination, not a user-facing problem. If the cap is ever hit, the follow-up is the same keyset cursor pattern F-7's events endpoint uses. Noted here so a future reviewer doesn't re-open the discussion.

**`includeClosed=true` eviction safety.** A flat `ORDER BY priority ASC, updated_at DESC LIMIT 500` is unsafe when closed rows are included: a task that was P0 and resolved yesterday sorts above a currently-open P1 that hasn't been touched in a week, so closed rows can evict open ones from the 500-row window. The partition-first sort above fixes this: all open rows (`status NOT IN ('done','cancelled')`) sort ahead of all closed rows regardless of priority or `updated_at`, so the 500-row cap truncates closed tasks first. In the default `includeClosed=false` case the partition key is constant (all rows are open) and the sort degenerates to the original `priority ASC, updated_at DESC` — no behaviour change. If Phase E ever produces enough open tasks to hit the 500 cap on their own, a split-LIMIT (`open LIMIT 500 UNION ALL closed LIMIT 500`) is the next step; not needed at Phase B scale.

**Index.** The schema already defines `idx_tasks_status_priority_updated ON tasks(status, priority, updated_at DESC)` (see `db/schema.ts`), added specifically for "task list view (design §8.4): filter by status, sort by priority then age". The default `listTasks` plan — filter `status NOT IN ('done','cancelled')`, then sort by `priority ASC, updated_at DESC` — uses this index via SQLite's leftmost-prefix rule (the `NOT IN` decomposes to two equality probes on `status` at plan time). No new index required. The partition-first sort above (`(status IN ('done','cancelled')) ASC, …`) is a computed expression and will not use the index for the partition key itself — expect SQLite to index-scan for the status prefix, partition the 500-row window in memory, and return. At Phase B scale this is trivial; calling it out so a future reviewer isn't surprised by the query plan.

## Decision 2 — "Agents" column renders as inline chips, oldest-first

One task can have N assignments across its dispatch cycles. The column shows a horizontal row of agent-name chips, oldest assignment on the left (matches dispatch order). Active assignments render at full opacity; terminal assignments (`completed`, `failed`, `cancelled`) render at 50% opacity with a strike-through-on-hover tooltip.

**Chip overflow:** when more than three chips would render, show the first two plus a `+N` tail chip. Clicking the tail expands the row inline (does not open the drill-down — the drill-down is gated on the row body click, Decision 5).

**Why not a count** (e.g., "3 agents")? Loss of information; the operator needs to see which specific heads are on a task (e.g., "is Luna blocked on this?") without another click. Chips are visually scannable at the densities we care about (≤5 chips per row).

**Why oldest-first** rather than active-first? Stable visual order across refreshes — an agent's position doesn't jump when it transitions state. Active-first would reorder the chips every time state changes, which is animation noise for no information gain.

## Decision 3 — Filter state is persisted in `location.hash`, not localStorage

v1 filters are `priority` (multi-select: which P-lanes to show) and `age` (single threshold: "hide tasks < N minutes old"). Per §8.4 v1 scope. `includeClosed` is a third filter added by Decision 1.

**Storage:** serialized to `location.hash` as a tiny query string. Example: `#tasks?p=0,1&age=0&closed=0`.

**Why hash, not localStorage?**

- Filter state is **shareable** — an operator can paste a URL into Discord/Slack ("here's the P0 blocked view") and the recipient sees the same filter.
- Filter state is **per-tab** — two dashboards open side-by-side can show different filters without collision. localStorage is shared across tabs.
- Filter state is **ephemeral** — we don't want "I was filtering P0-only three weeks ago" to persist after the user closes the tab. Hash clears on close.
- No dependency on storage permissions (some browser modes block localStorage).

**F-7 consistency:** F-7's drill-down state is also not persisted (Decision 2 of that addendum explicitly defers hash routing). F-8 introduces hash state for filters only — the drill-down overlay remains an in-memory-only affordance. When F-10 adds shareable drill-down URLs, the two hash schemes (`#tasks?…` and `#a/:id`) compose cleanly.

## Decision 4 — Aggregate "state" is worst-case by operator-attention severity

The table's `state` column shows one state per task, but a task may have multiple assignments in different states. §8.4 says "worst-case across assignments" without defining the order.

**Order (worst first — highest operator attention):**

```
blocked > running > dispatched > queued > failed > completed > cancelled
```

Reasoning:

- `blocked` is the top of the list because it is the only state that can need operator input right now.
- `running / dispatched / queued` are in-flight active states, ordered by how close to work they are (running is burning resources, dispatched has been accepted, queued is waiting).
- `failed` outranks `completed` because it is a terminal-bad state that an operator might want to resurface.
- `cancelled` is the lowest because it means the task's progress is no longer something to reason about.

**Implementation:** `aggregate_state` is computed server-side on the `/api/tasks` projection (Decision 1). The full rank mapping (lower = more attention-worthy):

| State | Rank |
|---|---|
| `blocked` | 0 |
| `running` | 1 |
| `dispatched` | 2 |
| `queued` | 3 |
| `failed` | 4 |
| `completed` | 5 |
| `cancelled` | 6 |

SQL (computed inline on the task's assignments via a subquery or LEFT JOIN + GROUP BY — exact shape is the implementer's call, but the CASE mapping is fixed):

```sql
MIN(CASE a.state
      WHEN 'blocked'    THEN 0
      WHEN 'running'    THEN 1
      WHEN 'dispatched' THEN 2
      WHEN 'queued'     THEN 3
      WHEN 'failed'     THEN 4
      WHEN 'completed'  THEN 5
      WHEN 'cancelled'  THEN 6
    END) AS aggregate_state_rank
```

The rank is then reverse-mapped to the state string on the TypeScript side at hydrate time (simple array lookup: `STATE_RANKS[rank] ?? null`). Doing the reverse mapping in TS rather than a correlated-subquery in SQL keeps the query flat and makes the null-propagation case (no rows → NULL rank → null state) trivial. `MIN(CASE …)` over zero rows naturally returns `NULL`, which matches the `aggregate_state = null` behaviour specified for tasks with empty `assignments[]`.

Note the two counter-intuitive orderings in this table: `dispatched > queued` (dispatched is further-along than queued, but from an *attention* perspective a dispatched assignment is actively holding a slot, so it outranks a queued one that's merely waiting), and `failed > completed > cancelled` (all three are terminal, ranked by "likelihood an operator wants to resurface this"). These are the ranks used everywhere the worst-case order appears — Decision 5 tie-break, the WS refresh trigger semantics — so pinning them down once avoids drift.

**Empty-assignment case:** a task that has never had an assignment (Phase E "added-but-not-dispatched" — a state F-8 doesn't create but may surface if Phase E backfills) shows `aggregate_state = null`. The column renders as a dim em-dash with tooltip "No assignment yet".

## Decision 5 — Row click opens the F-7 drill-down; chip clicks are inert (for now)

§8.5: "Opening a task from the table opens the attention view for that task's primary active assignment." F-8 executes this literally.

**"Primary active" tie-break** (when a task has multiple active assignments):

1. Prefer `blocked` over any other state (mirrors the aggregate-state ordering).
2. Within the same state, prefer the assignment with the most recent `updated_at`.

**Chip click:** no-op in F-8. The chips are metadata, not a secondary entry point. If we make them clickable later (open the drill-down for that specific assignment), it's an additive change to the existing click handler. Calling this out explicitly so a reviewer doesn't flag the chips as broken links.

**Task with no active assignment** (all terminal or none): clicking the row opens the drill-down anyway, which renders the task's latest session events (already supported by F-7's `findLatestSessionForAssignment`). Metadata is read-only; the `[Dispatch]` button §8.5 describes is **deferred to F-12 (Phase E)** — listed as *"Add to queue from GitHub issue, manual dispatch, manual requeue / abandon / hand-off"* in `docs/iteration-mission-control.md` under Phase E. F-8 renders a disabled placeholder with tooltip "Manual dispatch ships in Phase E". Same pattern F-7 used for the input affordance (Decision 1 of F-7 addendum) and Approve/Deny buttons (Decision 6 of F-7 addendum).

## Decision 6 — Closed tasks default-hidden, toggle above table

A single checkbox above the table: "Show closed". Off by default. When on, `status IN ('done','cancelled')` rows appear at the bottom of the sort order at reduced opacity — same visual treatment as terminal assignment chips (Decision 2).

**Why not a tab** (Active / Closed / All)? Tabs imply mutually exclusive views; in practice an operator looking at a closed task often wants to see whether there's an open follow-up at the same priority. One list with a toggle supports that without a view switch.

**State persists via hash** (Decision 3). Two operators at the same URL see the same inclusion policy.

## Decision 7 — Empty-state copy + copy-edits

Three empty states the table can render:

| Condition | Copy | Visual |
|---|---|---|
| No tasks at all | "No tasks in this workspace yet. When agents are dispatched or issues are queued, they appear here." | Medium-weight, centered, full column width. |
| Filtered out (tasks exist but current filter hides them all) | "No tasks match the current filter. [Clear filters]" | Same weight, `[Clear filters]` is a button that resets hash. |
| Closed-only (unchecked "show closed" but all remaining are closed) | "All tasks here are closed. Toggle 'Show closed' above to see them." | Same weight. |

No decorative graphics / icons in v1 — the parent spec's aesthetic is text-forward.

## Decision 8 — Sort stability within priority ties uses `updated_at DESC`

§8.4 says "within a priority lane, default sort is oldest first (longest-waiting surfaces first)." That rule applies to the **focus area** (F-6, `updated_at ASC` — longest-blocked surfaces first). For the **task table**, the operator is scanning all work, not triaging blockage, so the tie-break is **most recently touched first** (`updated_at DESC`).

**Concretely:**

- Primary: `priority ASC`.
- Secondary (tie-break): `updated_at DESC`.
- Tertiary (sub-second ties on `updated_at`): `id ASC`. Deterministic — our `generateId` is time-sortable so this is only a tiny deterministic nudge at the millisecond boundary.

Sort direction on any column is operator-toggleable. The **default** is what the server returns; re-sort is client-side.

## Decision 9 — Table is inline in the main column; not a separate route

Matches F-7's overlay-not-route decision for the same reasons: the dashboard is a single inline HTML file with no build step. The task table renders in the main content column below the focus area and working-agent grid (§8.1 layout). No tabs, no routing; scroll to reach it.

**Keyboard navigation in F-8:**

- Column-header `click` toggles sort direction.
- `f` focuses the filter bar.
- `/` focuses a search box (title substring — added as a stretch per Decision 10).
- `Enter` on a focused row opens the drill-down (same primitive as F-6/F-7).
- `Esc` blurs the currently-focused control.

Selection indicator reuses F-6's `1`–`9` paradigm? **No** — F-6's 1–9 works because the focus area caps at 9 cards. A task table can have hundreds of rows; numeric keys would be misleading. F-8 uses arrow-key navigation on the rows when the table has focus.

## Decision 10 — Title search is in scope; source-system filter is not

§8.4 v1 filter list is `priority` and `age`. A title-substring search box is a 10-line addition that costs nothing and is the single most likely first ask after F-8 lands. Included.

**Scope: client-side.** The filter runs in-browser over the already-fetched 500-row payload — no `title LIKE ?` parameter on `/api/tasks`, no server round-trip on each keystroke. At 500 rows this is trivially fast and keeps the endpoint surface area minimal. When the working-set outgrows the 500-row cap (same trigger as pagination), promote search to a server-side `WHERE title LIKE ?` together with the keyset cursor; until then, client-side.

**Matching semantics.** Case-insensitive substring match on trimmed input; no regex, no whole-word mode, no fuzzy. An empty query (after trim) matches everything. No need to over-spec beyond that.

**Not in F-8:**

- Source-system filter (github vs internal) — deferred until Phase E task curation gives operators more than one source that matters.
- Agent filter (show only Luna's tasks) — deferred, probably a URL-level filter in a later iteration.
- Date-range filter on `created_at` — deferred; `age` threshold covers the v1 need.

## Scope summary — what F-8 SHIPS

- `GET /api/tasks` endpoint returning task-keyed projection with assignment roll-up, `aggregate_state`, and `includeClosed` toggle (Decisions 1, 4).
- `listTasks(db, { includeClosed })` in a new `src/mission-control/db/tasks.ts`.
- Task table section in `dashboard/index.html` below the focus area (Decision 9).
- Columns: Priority, Title, Agents (inline chips, oldest-first, overflow after 3), State (aggregate), Age (Decision 2).
- Sort: column-header click; defaults per Decision 8.
- Filters: priority multi-select, age threshold slider, title-substring search, closed-toggle (Decisions 6, 10).
- Filter state persisted to `location.hash` (Decision 3).
- Row click opens F-7 drill-down for the task's primary active assignment (Decision 5).
- Empty states per Decision 7.
- Re-fetch on WS `state.transition` that could change aggregate state (i.e., every transition, since aggregate-state depends on all assignments). Debounced 100 ms. **Asymmetry with F-6 is intentional:** F-6 re-fetches only on transitions where `from === 'blocked'` or `to === 'blocked'` (the only ones that can change focus-area membership), whereas F-8 re-fetches on every `state.transition` because `aggregate_state` is a function of the full seven-state ordering (Decision 4) and any transition — e.g., `running → completed` on one of several assignments — can change a task's aggregate. Implementers copying F-6's trigger filter by accident would get a silently-stale table. If profiling later shows the 100 ms debounce is too tight under burst transitions (e.g., 20 assignments entering `dispatched` in the same second, each triggering a 500-row payload), widen the debounce or move to a delta-push — not a v1 concern.
- Tests: endpoint filtering + closed toggle + aggregate-state computation; dashboard sort toggle unit tests (pure functions exported from the inline bundle if feasible, otherwise one integration test).

## Scope summary — what F-8 DEFERS

- Manual dispatch button for tasks with no active assignment (F-12 / Phase E).
- Chip click → drill-down to that specific assignment (additive, later).
- Source-system / agent / date-range filters (Decision 10).
- Server-side sort params + cursor pagination (add when the 500-row cap is hit).
- Task creation / editing from the UI (Phase E).

## Acceptance criteria

- [ ] `GET /api/tasks` returns task-keyed rows with `assignments[]` + `aggregate_state`, default-excludes `done`/`cancelled`, supports `?includeClosed=true`, clamps at 500.
- [ ] Task table renders below the focus area and working-agent grid slots.
- [ ] Columns render per Decision 2 (agents) and Decision 4 (state).
- [ ] Default sort is `priority ASC, updated_at DESC`; clicking any sortable header toggles that column's direction.
- [ ] Priority multi-select, age threshold, title search, and closed-toggle all operate client-side; all four persist to `location.hash`.
- [ ] Reloading the page with an existing hash restores the filter state.
- [ ] Row click opens the F-7 drill-down for the primary active assignment (Decision 5 tie-breaks).
- [ ] Task with no active assignment shows a disabled "Dispatch (Phase E)" button in its drill-down.
- [ ] Empty states render per Decision 7.
- [ ] WS `state.transition` debounce-triggers a refresh; no flicker under rapid transitions.
- [ ] All existing mission-control tests still pass; new tests for endpoint + filter + aggregate-state ship green.

## Where this goes

- New endpoint: `src/mission-control/api/handlers.ts` + route in `server.ts` + types in `api/types.ts`.
- New DB module: `src/mission-control/db/tasks.ts` (export `listTasks`, `TasksListItem`).
- Dashboard: `src/mission-control/dashboard/index.html` — new table section, filter bar, sort handlers, hash-state (de)serializer.
- Tests: `src/mission-control/__tests__/api.test.ts` (endpoint), plus a new `__tests__/tasks.test.ts` for `listTasks` + aggregate-state SQL.

Forward-link from the main spec §8.4 added in the same PR that lands this addendum.
