/**
 * Grove Mission Control v2 — Task list queries.
 *
 * Used by GET /api/tasks to render the dashboard's task table (§8.4).
 * Returns a task-keyed projection that folds assignments into a roll-up
 * and computes a worst-case `aggregate_state` per the rank table in
 * `docs/design-mc-f8-task-table.md` Decision 4.
 *
 * Kept separate from `assignments.ts` because the projection shape is
 * task-first (one row per task with `assignments[]`) rather than
 * assignment-first (one row per assignment with `task` sub-object).
 */

import type { Database } from "bun:sqlite";
import type { AssignmentState, EndpointKind, TaskStatus } from "../types";
import { normalizeSqliteDatetime } from "./assignments";
import { SHADOW_AGENT_ID } from "./sessions";
import {
  MOST_RECENT_SESSION_COLUMNS,
  mostRecentSessionLeftJoin,
  hydrateSession,
  type SessionDenormRow,
} from "./session-join";
import type { IterationState } from "./iterations";

/** Assignment roll-up returned inside each TaskListItem. */
export interface TaskAssignmentRow {
  id: string;
  agent_id: string;
  agent_name: string;
  state: AssignmentState;
  /** ISO-8601 UTC. */
  updated_at: string;
  /**
   * F-20.F — most-recent session denormalised onto the assignment so the
   * F-7 drill-down's input-mode resolver
   * (`dashboard-v2/lib/drill-input.ts:resolveDrillInputMode`) can
   * distinguish observed sessions from controlled-but-ended ones without
   * a second fetch. Null when the assignment has no session yet — the
   * resolver maps that to `"ended"` (existing behaviour preserved).
   *
   * Shape mirrors `AssignmentListItem.session` (`db/assignments.ts:41`)
   * so `synthesiseFromTasks` in `app.tsx` can carry this field through
   * to the drill-down's `AssignmentListItem` shape one-to-one without a
   * lossy mapping.
   */
  session: {
    id: string;
    endpoint_kind: EndpointKind;
    started_at: string;
    ended_at: string | null;
  } | null;
}

/**
 * F-16 — denormalised iteration tag carried on each `TaskListItem` and
 * `AssignmentListItem` so the F-7 drill-down header chip and F-8 task
 * table iteration column can render in one round-trip without N+1
 * lookups.
 *
 * Three fields only — `id`, `title`, `state`. The dashboard never
 * renders the iteration body / source / etc. from this denorm; for the
 * full row the operator clicks through to the iteration detail surface
 * (which uses its own narrow per-id fetch). Keeping the shape tight
 * also keeps the `iteration.updated` patch payload small (Echo
 * grove-v2#42 Major 3 — header-only frames).
 *
 * Per design `docs/design-mc-iteration-planning.md` Decision 8 —
 * "F-7 drill-down header gains an iteration chip; F-8 task table
 *  optionally surfaces iteration column." The denorm is the cheapest
 * way to satisfy both without forking new endpoints; one JOIN at the
 * `tasks` boundary feeds both surfaces.
 */
export interface TaskIterationTag {
  id: string;
  title: string;
  state: IterationState;
}

export interface TaskListItem {
  id: string;
  title: string;
  priority: number;
  status: TaskStatus;
  /** ISO-8601 UTC (hydrated from INTEGER epoch). */
  created_at: string;
  /** ISO-8601 UTC (hydrated from INTEGER epoch). */
  updated_at: string;
  source_system: "github" | "internal";
  source_ref: string | null;
  source_url: string | null;
  assignments: TaskAssignmentRow[];
  /**
   * Aggregate state computed as the worst-case rank across the task's
   * assignments. Null when `assignments` is empty (no rank to minimize).
   */
  aggregate_state: AssignmentState | null;
  /**
   * F-12b — id of the `mc-shadow-agent` assignment created alongside the
   * task, or `null` for pre-F-12b / internal-source tasks. The dashboard's
   * `openTaskDrillDown` uses this to open the F-12 curation toolbar on the
   * shadow assignment when the task has no real assignments yet.
   *
   * See `docs/design-mc-f12b-add-to-queue.md` Decision 7 + 8.
   */
  shadow_assignment_id: string | null;
  /**
   * F-16 — the iteration this task belongs to, denormalised at fetch
   * time via a JOIN on `tasks.iteration_id → iterations`. NULL when
   * the task is ungrouped (`tasks.iteration_id IS NULL`). See
   * `TaskIterationTag` above for shape rationale.
   */
  iteration: TaskIterationTag | null;
}

export interface ListTasksOptions {
  includeClosed?: boolean;
}

/**
 * Safety cap. 500 is far above the Phase B working-set; hitting it is a
 * signal to add keyset pagination (same pattern F-7's events endpoint uses),
 * not a user-facing error.
 */
export const TASKS_QUERY_LIMIT = 500;

/**
 * Aggregate-state rank. Lower = more operator attention.
 * Locked in `docs/design-mc-f8-task-table.md` Decision 4; the two
 * counter-intuitive orderings (`dispatched > queued`, `failed > completed
 * > cancelled`) are deliberate and reused elsewhere (primary-active
 * tie-break for drill-down entry).
 *
 * MIRROR: the dashboard duplicates this ordering as the
 * `TASK_STATE_RANKS` object literal in `dashboard/index.html` (no
 * bundler, so no shared import). Edit both together.
 * `__tests__/state-ranks-sync.test.ts` pins them in lock-step.
 */
export const STATE_RANKS: readonly AssignmentState[] = [
  "blocked",
  "running",
  "dispatched",
  "queued",
  "failed",
  "completed",
  "cancelled",
];

/**
 * INTEGER epoch seconds → ISO-8601 UTC.
 *
 * Sibling of `normalizeSqliteDatetime` (TEXT → ISO-8601) in `assignments.ts`.
 * Exists because `tasks.created_at/updated_at` are stored as
 * `INTEGER NOT NULL DEFAULT (unixepoch())`, whereas
 * `agent_task_assignment.updated_at` is `TEXT DEFAULT (datetime('now'))`.
 * The helpers converge on the same wire contract (ISO-8601 UTC,
 * 'T' separator, 'Z' suffix).
 */
export function epochSecondsToIso(n: number): string {
  return new Date(n * 1000).toISOString();
}

interface TaskRow {
  id: string;
  title: string;
  priority: number;
  status: TaskStatus;
  created_at: number;
  updated_at: number;
  source_system: "github" | "internal";
  source_url: string | null;
  source_external_id: string | null;
  aggregate_state_rank: number | null;
  shadow_assignment_id: string | null;
  /**
   * F-16 — denormalised iteration columns from the `iterations` LEFT
   * JOIN. All three are NULL together when the task has no
   * `iteration_id` (LEFT JOIN nullable side); the hydrate path collapses
   * them into the optional `iteration: TaskIterationTag | null`.
   */
  iteration_id: string | null;
  iteration_title: string | null;
  iteration_state: IterationState | null;
}

interface AssignmentRow extends SessionDenormRow {
  id: string;
  task_id: string;
  agent_id: string;
  agent_name: string;
  state: AssignmentState;
  updated_at: string;
  created_at: string;
}

/**
 * List tasks with their assignment roll-up and aggregate state.
 *
 * Default (includeClosed=false) filters `status NOT IN ('done','cancelled')`.
 *
 * Sort: `(status IN ('done','cancelled')) ASC, priority ASC, updated_at DESC`.
 * The partition-first key keeps closed rows at the bottom when the toggle is
 * on so the 500-row cap truncates closed tasks first.
 *
 * In the default includeClosed=false case the partition is constant (all
 * open) and the sort degenerates to `priority ASC, updated_at DESC` —
 * which the `idx_tasks_status_priority_updated` covering index serves
 * via leftmost-prefix.
 */
export function listTasks(
  db: Database,
  opts: ListTasksOptions = {}
): TaskListItem[] {
  const includeClosed = opts.includeClosed === true;

  const statusFilter = includeClosed
    ? ""
    : `WHERE t.status NOT IN ('done','cancelled')`;

  // aggregate_state_rank is computed via a correlated subquery on
  // agent_task_assignment. MIN(CASE ...) over zero rows returns NULL, which
  // hydrates to `aggregate_state = null` for un-dispatched tasks.
  //
  // F-12b Decision 8 — the shadow assignment (`agent_id='mc-shadow-agent'`)
  // is excluded from the aggregate-state rank so a freshly-imported task
  // with only the shadow row hydrates to `aggregate_state = null` (the
  // visual "empty" state). The sibling `shadow_assignment_id` subquery
  // surfaces the shadow row id directly for the dashboard's
  // empty-assignment drill-down path.
  // F-16 — LEFT JOIN on iterations denormalises the (id, title, state)
  // tuple onto each task row so the dashboard can render the F-7
  // drill-down chip + F-8 task-table iteration column without an N+1
  // round-trip per task. The JOIN is LEFT because most tasks (legacy +
  // pre-F-13 imports + ungrouped operator-typed) have `iteration_id IS
  // NULL`; matching that side as nullable is the explicit "ungrouped
  // tasks render with `—` in the column" path from the design spec
  // §"Surface 3" without needing a separate query branch.
  const tasks = db
    .query(
      `SELECT
         t.id, t.title, t.priority, t.status,
         t.created_at, t.updated_at,
         t.source_system, t.source_url, t.source_external_id,
         (SELECT MIN(CASE a.state
                       WHEN 'blocked'    THEN 0
                       WHEN 'running'    THEN 1
                       WHEN 'dispatched' THEN 2
                       WHEN 'queued'     THEN 3
                       WHEN 'failed'     THEN 4
                       WHEN 'completed'  THEN 5
                       WHEN 'cancelled'  THEN 6
                     END)
            FROM agent_task_assignment a
            WHERE a.task_id = t.id
              AND a.agent_id != '${SHADOW_AGENT_ID}') AS aggregate_state_rank,
         (SELECT id FROM agent_task_assignment
            WHERE task_id = t.id
              AND agent_id = '${SHADOW_AGENT_ID}'
            LIMIT 1) AS shadow_assignment_id,
         i.id    AS iteration_id,
         i.title AS iteration_title,
         i.state AS iteration_state
       FROM tasks t
       LEFT JOIN iterations i ON i.id = t.iteration_id
       ${statusFilter}
       ORDER BY
         (t.status IN ('done','cancelled')) ASC,
         t.priority ASC,
         t.updated_at DESC,
         t.id ASC
       LIMIT ${TASKS_QUERY_LIMIT}`
    )
    .all() as TaskRow[];

  if (tasks.length === 0) return [];

  // One batch query for assignments across all returned tasks. Cheaper than
  // N+1 per-task queries, and keeps the row ordering deterministic.
  const taskIds = tasks.map((t) => t.id);
  const placeholders = taskIds.map(() => "?").join(",");
  // F-12b Decision 8 — exclude shadow assignments from the assignments
  // roll-up so the F-8 table's "Agents" column doesn't render the sentinel.
  // F-20.F — LEFT JOIN to the assignment's most-recent session so the
  // dashboard can resolve the drill-down's input mode (active /
  // observed / ended / shadow) without a second fetch. Shared
  // join + hydrate via `db/session-join.ts` so the two surfaces
  // (`/api/assignments` and `/api/tasks`) resolve "most-recent
  // session" identically — same SQL, same tiebreak (per Echo's PR
  // #57 review).
  const assignmentRows = db
    .query(
      `SELECT
         a.id, a.task_id, a.agent_id, a.state, a.updated_at, a.created_at,
         ag.name AS agent_name,
         ${MOST_RECENT_SESSION_COLUMNS}
       FROM agent_task_assignment a
       JOIN agents ag ON ag.id = a.agent_id
       ${mostRecentSessionLeftJoin("a")}
       WHERE a.task_id IN (${placeholders})
         AND a.agent_id != '${SHADOW_AGENT_ID}'
       ORDER BY a.created_at ASC, a.id ASC`
    )
    .all(...taskIds) as AssignmentRow[];

  const byTask = new Map<string, TaskAssignmentRow[]>();
  for (const row of assignmentRows) {
    const entry: TaskAssignmentRow = {
      id: row.id,
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      state: row.state,
      updated_at: normalizeSqliteDatetime(row.updated_at),
      session: hydrateSession(row),
    };
    const bucket = byTask.get(row.task_id);
    if (bucket) bucket.push(entry);
    else byTask.set(row.task_id, [entry]);
  }

  return tasks.map((t) => hydrate(t, byTask.get(t.id) ?? []));
}

/**
 * F-16 sweep — single-task fetcher mirroring `listTasks` shape.
 *
 * Used by the attach/detach handlers' `task.updated` broadcast to
 * surface a fresh `TaskListItem` (with the new `iteration` denorm)
 * after a successful link mutation. Returns `null` when the task id
 * is unknown.
 *
 * Always reads regardless of `status` — broadcasts must fire even
 * for tasks that have been closed since the operator opened them.
 */
export function getTaskById(db: Database, id: string): TaskListItem | null {
  const row = db
    .query(
      `SELECT
         t.id, t.title, t.priority, t.status,
         t.created_at, t.updated_at,
         t.source_system, t.source_url, t.source_external_id,
         (SELECT MIN(CASE a.state
                       WHEN 'blocked'    THEN 0
                       WHEN 'running'    THEN 1
                       WHEN 'dispatched' THEN 2
                       WHEN 'queued'     THEN 3
                       WHEN 'failed'     THEN 4
                       WHEN 'completed'  THEN 5
                       WHEN 'cancelled'  THEN 6
                     END)
            FROM agent_task_assignment a
            WHERE a.task_id = t.id
              AND a.agent_id != '${SHADOW_AGENT_ID}') AS aggregate_state_rank,
         (SELECT id FROM agent_task_assignment
            WHERE task_id = t.id
              AND agent_id = '${SHADOW_AGENT_ID}'
            LIMIT 1) AS shadow_assignment_id,
         i.id    AS iteration_id,
         i.title AS iteration_title,
         i.state AS iteration_state
       FROM tasks t
       LEFT JOIN iterations i ON i.id = t.iteration_id
       WHERE t.id = ?
       LIMIT 1`
    )
    .get(id) as TaskRow | null;
  if (!row) return null;
  // Reuse the same assignment-batch query shape — single-id case still
  // hits the same index. Same shared `db/session-join.ts` helpers as
  // `listTasks` so the two paths can't drift in tiebreak / hydrate.
  const assignmentRows = db
    .query(
      `SELECT
         a.id, a.task_id, a.agent_id, a.state, a.updated_at, a.created_at,
         ag.name AS agent_name,
         ${MOST_RECENT_SESSION_COLUMNS}
       FROM agent_task_assignment a
       JOIN agents ag ON ag.id = a.agent_id
       ${mostRecentSessionLeftJoin("a")}
       WHERE a.task_id = ?
         AND a.agent_id != '${SHADOW_AGENT_ID}'
       ORDER BY a.created_at ASC, a.id ASC`
    )
    .all(id) as AssignmentRow[];
  const assignments: TaskAssignmentRow[] = assignmentRows.map((r) => ({
    id: r.id,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    state: r.state,
    updated_at: normalizeSqliteDatetime(r.updated_at),
    session: hydrateSession(r),
  }));
  return hydrate(row, assignments);
}

function hydrate(row: TaskRow, assignments: TaskAssignmentRow[]): TaskListItem {
  // F-16 — collapse the three nullable iteration_* columns into the
  // single optional `iteration` field. The LEFT JOIN guarantees they
  // are NULL together (FK + non-null `iterations.title` + non-null
  // `iterations.state`); we still defensively check `iteration_id`
  // first because a future migration that allowed NULL titles would
  // otherwise yield a malformed tag.
  const iteration =
    row.iteration_id && row.iteration_title && row.iteration_state
      ? {
          id: row.iteration_id,
          title: row.iteration_title,
          state: row.iteration_state,
        }
      : null;
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    status: row.status,
    created_at: epochSecondsToIso(row.created_at),
    updated_at: epochSecondsToIso(row.updated_at),
    source_system: row.source_system,
    source_ref: row.source_external_id
      ? `${row.source_system}:${row.source_external_id}`
      : null,
    source_url: row.source_url,
    assignments,
    aggregate_state:
      row.aggregate_state_rank === null
        ? null
        : STATE_RANKS[row.aggregate_state_rank] ?? null,
    shadow_assignment_id: row.shadow_assignment_id,
    iteration,
  };
}
