# F-18 — Mission Control metrics (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f18-metrics.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §1.1 (goal: "operator's cockpit") and §7.4 (events stream as the audit substrate).
**Date:** 2026-04-27.
**Status:** Decided. Closes the open scope around "metrics that drive operator behaviour and provide signal to tweak the system" raised during the F-13→F-17 retro.

## Why this addendum

The mission-control spec is rich on the operator-loop primitives (focus area, attention drill-down, input affordance) and on the data substrate (state machine + events table) — but is silent on **aggregate observability**. After F-13→F-17 landed and the dashboard had real activity in it, the operator surfaced the gap explicitly: *"average cycle time, latency, wait time so we can optimise the workflow"*. F-18 closes that gap as a small, immediately-useful surface that can iterate based on what the data actually shows.

The spec is intentionally short. Metrics is a domain where over-design is more dangerous than under-design — three useful numbers in front of an operator beat thirty rarely-glanced charts. F-19 onwards is the place for sparklines, alerts, cost/token, drill-down — once the v1 surface has shown which cuts of the data are actually load-bearing.

## Decision 1 — No new schema

Every metric in F-18 is computed from data the system already records:

| Source | Captured by | Used for |
|---|---|---|
| `agent_task_assignment.created_at` | `db/assignments.ts` insert path | "queued at" anchor for cycle-time start |
| `events` rows with `type='state.transition'` | `db/transitions.ts:106` (in-transaction with the state UPDATE) | Time-in-state intervals |
| `state.transition` event payload `{ from, to, action, blockReason? }` | Same insert | Per-state and per-block-reason interval breakdown |
| `events.timestamp` (ISO-8601, monotonic per writer) | `db/events.ts:83` | Interval boundaries |
| `agents.id` / `agents.name` joined via `agent_task_assignment.agent_id` | Existing FK | Per-agent breakdown |

No schema migration. No new event types. No new instrumentation. F-18 is purely a read path over what's already there.

**Why this matters:** the metrics surface ships with whatever history is already in the DB the moment the code lands. The first dashboard load post-merge shows real numbers, not "no data yet — come back tomorrow."

## Decision 2 — Two computation entry points

`src/mission-control/db/metrics.ts` exposes exactly two pure functions over a `Database`:

```ts
computeAssignmentMetrics(db, assignmentId): AssignmentMetrics | null
computeFleetMetrics(db, opts: { since: Date; agentId?: string }): FleetMetrics
```

`computeAssignmentMetrics` returns `null` when the assignment doesn't exist; otherwise:

```ts
interface AssignmentMetrics {
  assignmentId: string;
  /** ms from queued → terminal (completed/failed/cancelled). null if in-flight. */
  totalCycleMs: number | null;
  /** Sum of ms spent in each state across the assignment's lifetime. */
  byState: Record<AssignmentState, number>;
  /** Sum of ms spent blocked, broken down by block_reason.kind. */
  byBlockReason: Record<BlockReason["kind"], number>;
  /** True when no terminal transition has fired yet. The byState/byBlockReason
   *  sums use `now()` as the right edge of the final interval. */
  inFlight: boolean;
}
```

`computeFleetMetrics`:

```ts
interface FleetMetrics {
  /** Window applied to the queries (echoed back for cache-keying on the client). */
  windowSinceIso: string;
  /** All assignments observed inside the window (started OR finished inside it). */
  count: number;
  /** Subset that reached a terminal state inside the window — basis for cycle-time stats. */
  completedCount: number;
  /** Percentiles over the completed cycle times. null when completedCount === 0. */
  p50CycleMs: number | null;
  p90CycleMs: number | null;
  p95CycleMs: number | null;
  /** Mean ms-per-assignment in each state across the window. */
  meanByState: Record<AssignmentState, number>;
  /** Mean ms-per-assignment blocked under each reason kind. */
  meanByBlockReason: Record<BlockReason["kind"], number>;
  /** Top three block reasons by total ms across the window, descending. */
  topBlockers: Array<{ kind: BlockReason["kind"]; totalMs: number; assignments: number }>;
  /** Per-agent rows. Sorted by completed DESC, then p50CycleMs ASC (faster first). */
  perAgent: Array<{
    agentId: string;
    agentName: string;
    completed: number;
    p50CycleMs: number | null;
    /** The block reason kind that consumed the most time across this agent's
     *  blocked intervals in the window. null if no blocked time recorded. */
    topBlocker: BlockReason["kind"] | null;
  }>;
}
```

**Why two entry points and not one:** the assignment-scoped function is needed for a future "drill into one assignment from the table row" affordance (deferred to F-19); shipping both in F-18 means the hook for that affordance is wired even though the F-18 UI only exposes the fleet view. Cost is one extra exported function; benefit is no second design pass when F-19 lands.

## Decision 3 — Computation algorithm

Walk the `state.transition` events for an assignment in `timestamp ASC` order. The interval `[Tn, Tn+1)` was spent in state `from(n+1)` (the state we transitioned **out of** at Tn+1). The first interval `[created_at, T0)` was spent in `queued` (the implicit initial state — assignments are inserted with `state='queued'`, the first transition out is recorded as `from='queued'`). The final interval is one of:

- **Terminal transition fired:** interval ends at the terminal transition's timestamp; `inFlight=false`.
- **No terminal transition (assignment is still active):** interval ends at `now()`; `inFlight=true`; `totalCycleMs` is `null`.

For block reason breakdown: each `from=*, to='blocked'` transition's payload carries `blockReason.kind`. The interval until the next transition (`from='blocked', to=*`) is attributed to that kind. If a single blocked period is somehow followed by another blocked transition without an intervening non-blocked state (state machine forbids this — but the safety net), the previous block reason owns its segment and the new one owns the next.

**Percentile computation:** sort the completed cycle times ascending, pick the index at `ceil(p * n) - 1` (clamped to `[0, n-1]`). Standard nearest-rank — adequate for the operator-readable "median / p90 / p95" numbers; no interpolation, no t-digest. Re-evaluate if the sample size grows past O(10⁴) per window.

**Window membership for fleet metrics:** an assignment counts in the window if EITHER its `created_at` is `>= since` OR its terminal transition's `timestamp` is `>= since`. This catches both "started in the window" and "finished in the window", which matches operator intuition ("show me the last 24h of activity"). Assignments that started before and finished before the window are excluded; assignments that started before and are still in-flight at the window edge are included.

**Why Date math in TS, not SQL:** the JOIN / window-function cost is identical, and TS lets us reuse the same `BlockReason` tagged-union type the rest of the system already validates against (no JSON-extract gymnastics in SQLite). The function loads the raw `state.transition` rows for the windowed assignments — at Phase B operator scale, hundreds of rows max per query — and computes intervals in a single linear pass per assignment. SQL handles row selection; TS handles arithmetic.

## Decision 4 — REST surface

Two read-only endpoints, both registered in `src/mission-control/server.ts` alongside the existing `/api/*` switch:

```
GET /api/metrics/assignment/:id
  200  { metrics: AssignmentMetrics }
  404  if assignment id not found

GET /api/metrics/fleet?window=24h|7d|30d&agent=<id?>
  200  { metrics: FleetMetrics }
  400  if window param missing or not in the allowlist
```

`window` is intentionally a closed allowlist (`24h | 7d | 30d`) rather than a free-form duration string. Three windows cover the operator-readable cases; opening it up invites bikeshedding (`6h`? `90d`?) without driving operator behaviour. Add new windows here only if a real workflow requires them.

`agent` is optional; when omitted, fleet metrics span all agents. When present, `count` / `completedCount` / cycle-time stats are scoped to that agent's assignments only, and `perAgent` is a single-element array (echoing the filter for client convenience).

**No write endpoints in F-18.** Metrics are read-only by definition. Configuration knobs (custom windows, alerting thresholds) are deferred — there's nothing to configure until we know what the operator wants to act on.

**No WebSocket push of metrics.** The fleet view refreshes on user-initiated window switches and on the existing `state.transition` WS event (a rolled-up transition recomputes the fleet view client-side via refetch — same pattern as `use-iterations`). Real-time push of computed aggregates is overkill for v1; deferred to F-19 if operators ask for it.

## Decision 5 — UI surface

A new top-nav tab `Metrics`, third in order between `Focus / Working / Tasks` and `Iterations`. The component lives at `dashboard-v2/components/metrics-panel.tsx` with sibling `metrics-panel.css` and a hook at `dashboard-v2/hooks/use-metrics.ts`.

Three sections, no chart library, all rendered via flexbox + CSS variables (matches the existing design language — no Tailwind, no recharts):

1. **Cycle time** card — window selector (`24h` / `7d` / `30d` segmented control), then four big-number cells: `count`, `p50`, `p90`, `p95`. Numbers are formatted as `Xs` / `Xm` / `Xh` / `Xd` per a `formatDurationShort` helper. The window selector triggers a refetch with the new `window` query param.

2. **Wait-time breakdown** — one horizontal stacked bar showing the relative contribution of each state and block-reason category to total time across the window. Categories: `queued`, `running`, `blocked-permission`, `blocked-tool-error`, `blocked-review`. A small legend underneath maps colours to categories with the absolute mean time in parentheses. The bar is purely CSS (`flex: <ms>`) — no SVG, no library.

3. **Per-agent table** — columns: `Agent`, `Completed`, `p50 cycle`, `Top blocker`. Sortable by header click (client-side, in-memory; the per-agent array is short — at most O(10) rows). The agent name is plain text in v1; clicking it doing nothing yet (drill-down deferred to F-19).

Loading / error state mirrors `iteration-board.tsx`:
- Boot fetch in flight: skeleton placeholders for the three sections.
- Boot fetch failed: red error pill at the top of the panel with the error message.
- Refetch failed: console warn only (don't pop a banner on every WS-driven refresh).

## Decision 6 — Refresh strategy

- **Boot:** one fetch on mount with `window=24h` (the default).
- **Window switch:** abort any in-flight fetch, refetch with the new window. Out-of-order responses dropped via the `genRef` pattern from `use-iterations`.
- **Live updates:** subscribe to the `state.transition` WS event. On each frame, debounce 500 ms then refetch. 500 ms is intentionally slower than the 100 ms used by `use-iterations` — metrics don't need single-event resolution; one refresh per quiet half-second is plenty.

## Open questions

- **Q1 — Wait-for-token (API latency).** Out of scope for F-18; needs a code-trace check first that the bot persists CC `usage` events into our `events` table. If yes, derive `wait-for-token` as `assistant.message.timestamp - operator.input.timestamp` with operator-input-not-followed-by-an-assistant-response handled as a boundary condition. Filed as F-19.1.

- **Q2 — Cost per assignment.** Same precondition as Q1 (CC `usage` events landing in our events table). When that lands, `byAgentCostUsd` is a one-line addition to `FleetMetrics`. F-19.2.

- **Q3 — Stale-fleet truncation.** At Phase B scale (tens to hundreds of assignments), the windowed query is fine. At Tier 2 / multi-operator scale, `since=30d` could pull thousands. Not a blocker for v1; flagged for the same SQL-level windowing pass that F-7's events endpoint already uses. F-19.3.

- **Q4 — Sparklines / time-series view.** The current surface is point-in-time aggregates only. Sparklines (cycle time over the last 30d) would need either a daily rollup table or a per-day GROUP BY at query time. Defer to F-19 once F-18 has been in operator hands long enough to know if the trend view is actually wanted.

## Deferred to F-19+

- Cost / token metrics (Q1, Q2 above)
- Drill-from-metric-to-assignment (clicking an agent name → opens the per-assignment metrics view)
- Sparklines / trend charts (Q4)
- Alerting thresholds (e.g., "p90 over 4h triggers a Discord ping")
- Cross-host metrics (Tier 2 only — same posture as the rest of the spec; multi-operator is parked)
- Custom windows beyond the 24h / 7d / 30d allowlist
- Per-task or per-iteration metrics (the assignment is the fundamental unit of work in the spec — task and iteration breakdowns are roll-ups of assignment metrics, easy to add when needed)
