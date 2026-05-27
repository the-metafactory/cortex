/**
 * Grove Mission Control v2 — Assignment list queries.
 *
 * Used by GET /api/assignments and GET /api/focus-area to render the
 * dashboard's task/session list and the "who needs me" row respectively.
 * Joins agent_task_assignment with tasks and the most-recent session so
 * the client can render state + block_reason + endpoint_kind in a single
 * round-trip.
 */

import type { Database } from "bun:sqlite";
import type {
  AssignmentState,
  BlockReason,
  EndpointKind,
} from "../types";
import type { TaskIterationTag } from "./tasks";
import {
  MOST_RECENT_SESSION_COLUMNS,
  mostRecentSessionLeftJoin,
  hydrateSession,
} from "./session-join";

export interface AssignmentListItem {
  id: string;
  state: AssignmentState;
  block_reason: BlockReason | null;
  created_at: string;
  updated_at: string;
  /**
   * F-12b — raw agent id. Surfaced so the dashboard's
   * `resolveDrillInputMode` can detect `agent_id === 'mc-shadow-agent'`
   * and route to the "shadow" input mode (`docs/design-mc-f12b-add-to-queue.md`
   * Decision 7 sub-decision).
   */
  agent_id: string;
  task: {
    id: string;
    title: string;
    priority: number;
  };
  /**
   * Most-recent session for the assignment (active or not).
   * Null if the assignment has never had a session.
   */
  session: {
    id: string;
    endpoint_kind: EndpointKind;
    started_at: string;
    ended_at: string | null;
  } | null;
  /**
   * F-16 — denormalised iteration the assignment's task belongs to.
   * Powers the F-7 drill-down header chip ("Iteration: <title>").
   * NULL when the task is ungrouped. Same shape + JOIN strategy as
   * `TaskListItem.iteration` (`tasks.iteration_id → iterations`); kept
   * type-aliased so a future change to `TaskIterationTag` flows here
   * automatically.
   */
  iteration: TaskIterationTag | null;
}

interface JoinedRow {
  id: string;
  state: AssignmentState;
  block_reason: string | null;
  created_at: string;
  updated_at: string;
  agent_id: string;
  task_id: string;
  task_title: string;
  task_priority: number;
  session_id: string | null;
  session_endpoint_kind: EndpointKind | null;
  session_started_at: string | null;
  session_ended_at: string | null;
  /**
   * F-16 — denormalised iteration via `tasks.iteration_id → iterations`.
   * Three nullable columns hydrated together by the LEFT JOIN; collapse
   * to `iteration: TaskIterationTag | null` in `hydrate`.
   */
  iteration_id: string | null;
  iteration_title: string | null;
  iteration_state: string | null;
}

/**
 * Projection of `agent_task_assignment` + `tasks` + most-recent `session`,
 * shared between `listAssignments` and `listFocusArea`. Shared so that any
 * future change to the "most-recent session per assignment" definition
 * (e.g. exclude ended sessions, prefer active over historical) touches one
 * place rather than two hand-kept-in-sync copies.
 *
 * Keeps the full FROM/JOIN clause verbatim; callers append their own
 * WHERE/ORDER BY/LIMIT.
 */
// F-16 — `LEFT JOIN iterations` denormalises (id, title, state) onto
// each assignment row so the F-7 drill-down header can render the
// "Iteration: <title>" chip without an N+1 lookup. The JOIN is LEFT
// because most tasks have `iteration_id IS NULL` (legacy + ungrouped
// + pre-F-13 imports); the chip simply omits when all three columns
// hydrate as null. Mirrors the same JOIN added to `db/tasks.ts` so
// the two surfaces (drill-down + task table) read the same denorm.
// F-20.F sweep — shared "most-recent session" join + columns live in
// `db/session-join.ts` so this surface and `db/tasks.ts` can't drift on
// tiebreak. Earlier copy here used `ORDER BY started_at DESC` only;
// `started_at` defaults to `datetime('now')` (1-second granularity), so
// same-second insert ties resolved differently across `/api/assignments`
// and `/api/tasks` once F-20.F shipped a second copy. Single source of
// truth fixes that. Per Echo's PR #57 review.
const ASSIGNMENT_JOIN_SELECT = `SELECT
  a.id, a.state, a.block_reason, a.created_at, a.updated_at,
  a.agent_id AS agent_id,
  t.id AS task_id, t.title AS task_title, t.priority AS task_priority,
  ${MOST_RECENT_SESSION_COLUMNS},
  i.id    AS iteration_id,
  i.title AS iteration_title,
  i.state AS iteration_state
 FROM agent_task_assignment a
 JOIN tasks t ON t.id = a.task_id
 LEFT JOIN iterations i ON i.id = t.iteration_id
 ${mostRecentSessionLeftJoin("a")}`;

/**
 * Safety cap for the focus-area query. The client only renders
 * `FOCUS_MAX_VISIBLE = 6` cards plus a "+N more" tail chip, so transmitting
 * the full blocked partition is wasteful. 100 is well above any plausible
 * principal working-set; anything larger means something else is wrong.
 *
 * Exported so tests (and any future pagination cursor) can reference the
 * same ceiling.
 */
export const FOCUS_AREA_QUERY_LIMIT = 100;

/**
 * List all assignments with their task and most-recent session.
 *
 * Ordering: active (non-terminal) assignments first (sorted by updated_at DESC),
 * then terminal (completed/cancelled/failed) assignments below. This matches
 * the dashboard's attention model — what needs your attention sits on top.
 */
export function listAssignments(db: Database): AssignmentListItem[] {
  const rows = db
    .query(
      `${ASSIGNMENT_JOIN_SELECT}
       ORDER BY
         CASE a.state
           WHEN 'blocked' THEN 0
           WHEN 'running' THEN 1
           WHEN 'dispatched' THEN 2
           WHEN 'queued' THEN 3
           ELSE 4
         END,
         a.updated_at DESC`
    )
    .all() as JoinedRow[];

  return rows.map(hydrate);
}

/**
 * Focus area query (design-mc-f6-focus-area.md §2).
 *
 * F-6 v1: blocked-only. The three BlockReason kinds (permission.request,
 * tool.error, review.checkpoint) all land the assignment in `blocked`, so this
 * covers 100% of attention signals until F-10 adds `principal.input.requested`
 * events for the soft-prompt path.
 *
 * Ordering: task.priority ASC (P0 first), then updated_at ASC (oldest-waiting
 * first within a priority lane — matches design-mission-control.md §8.4).
 *
 * LIMIT: server-side cap at FOCUS_AREA_QUERY_LIMIT. The dashboard already caps
 * visible cards at 6 + overflow chip; this guards against a runaway blocked
 * partition from flooding the wire. See PR #8 review finding S6.
 *
 * Index strategy: idx_ata_state is sufficient at Phase B scale — blocked is a
 * small partition. If profiling shows pressure, follow up with composite
 * (state, updated_at) on agent_task_assignment and/or (priority, updated_at)
 * on tasks. Noted in the addendum so future reviewers don't re-answer.
 */
export function listFocusArea(db: Database): AssignmentListItem[] {
  const rows = db
    .query(
      `${ASSIGNMENT_JOIN_SELECT}
       WHERE a.state = 'blocked'
       ORDER BY t.priority ASC, a.updated_at ASC
       LIMIT ${FOCUS_AREA_QUERY_LIMIT}`
    )
    .all() as JoinedRow[];

  return rows.map(hydrate);
}

export interface MostActiveAgent {
  /** Agent id from the `agents` table. */
  id: string;
  /** Agent display name. */
  name: string;
  /** Assignment the agent is currently running. */
  assignmentId: string;
  /** Task title the agent is working on. */
  taskTitle: string;
  /**
   * When we last saw activity. Either the most recent event's timestamp
   * (when within the recent-activity window) or the assignment's updated_at
   * otherwise. ISO-8601.
   */
  lastActivityAt: string;
}

/**
 * "Most-active agent" one-liner source for the focus-area empty state
 * (design-mc-f6-focus-area.md §2.6).
 *
 * Definition from the spec: "whichever `running` assignment has the newest
 * event in the last minute, or the newest `updated_at` if none in that
 * window." Returns null when no assignment is in `running` — at which point
 * the empty state shows only the static "All clear" message.
 *
 * Two-phase lookup:
 *   1. Prefer a running assignment with an event within the last 60s — this
 *      captures true live activity.
 *   2. Fall back to the most recently updated running assignment when nothing
 *      is streaming events.
 */
export function mostActiveAgent(db: Database): MostActiveAgent | null {
  // Phase 1: running assignment with the freshest event in the last 60s.
  // `events.timestamp` is the source of truth for "live" activity; we join
  // via sessions because events are keyed by session_id.
  const recentRow = db
    .query(
      `SELECT
         a.id AS assignment_id,
         ag.id AS agent_id,
         ag.name AS agent_name,
         t.title AS task_title,
         MAX(e.timestamp) AS last_event_ts
       FROM agent_task_assignment a
       JOIN agents ag ON ag.id = a.agent_id
       JOIN tasks t ON t.id = a.task_id
       JOIN sessions s ON s.assignment_id = a.id
       JOIN events e ON e.session_id = s.id
       WHERE a.state = 'running'
         AND e.timestamp >= datetime('now', '-60 seconds')
       GROUP BY a.id
       ORDER BY last_event_ts DESC
       LIMIT 1`
    )
    .get() as
    | {
        assignment_id: string;
        agent_id: string;
        agent_name: string;
        task_title: string;
        last_event_ts: string;
      }
    | null;

  if (recentRow) {
    return {
      id: recentRow.agent_id,
      name: recentRow.agent_name,
      assignmentId: recentRow.assignment_id,
      taskTitle: recentRow.task_title,
      lastActivityAt: normalizeSqliteDatetime(recentRow.last_event_ts),
    };
  }

  // Phase 2: freshest running assignment by updated_at (no event in the
  // activity window — agent is running but quiet, or brand-new).
  const fallbackRow = db
    .query(
      `SELECT
         a.id AS assignment_id,
         a.updated_at,
         ag.id AS agent_id,
         ag.name AS agent_name,
         t.title AS task_title
       FROM agent_task_assignment a
       JOIN agents ag ON ag.id = a.agent_id
       JOIN tasks t ON t.id = a.task_id
       WHERE a.state = 'running'
       ORDER BY a.updated_at DESC
       LIMIT 1`
    )
    .get() as
    | {
        assignment_id: string;
        updated_at: string;
        agent_id: string;
        agent_name: string;
        task_title: string;
      }
    | null;

  if (!fallbackRow) return null;

  return {
    id: fallbackRow.agent_id,
    name: fallbackRow.agent_name,
    assignmentId: fallbackRow.assignment_id,
    taskTitle: fallbackRow.task_title,
    lastActivityAt: normalizeSqliteDatetime(fallbackRow.updated_at),
  };
}

// `normalizeSqliteDatetime` was lifted to `db/datetime.ts` per Echo's
// PR #57 cycle-2 nit so `db/session-join.ts` can consume it without a
// circular import back here. Re-exported for the existing call sites
// (db/tasks.ts, etc.) so the migration is non-breaking. Also imported
// (not just re-exported) so the local references inside this file
// keep resolving.
import { normalizeSqliteDatetime } from "./datetime";
export { normalizeSqliteDatetime };

function hydrate(row: JoinedRow): AssignmentListItem {
  // F-16 — collapse the LEFT JOIN's three nullable iteration_*
  // columns into the denormalised `iteration` tag. NULL together when
  // the assignment's task is ungrouped (`tasks.iteration_id IS NULL`).
  // Cast `iteration_state` to the typed enum at the boundary; the
  // SQL CHECK constraint on `iterations.state` (db/iterations.ts +
  // schema migration) is the source of truth — any future enum
  // tightening lands here as a TS error, not a runtime crash.
  const iteration: TaskIterationTag | null =
    row.iteration_id && row.iteration_title && row.iteration_state
      ? {
          id: row.iteration_id,
          title: row.iteration_title,
          state: row.iteration_state as TaskIterationTag["state"],
        }
      : null;
  return {
    id: row.id,
    state: row.state,
    block_reason: row.block_reason
      ? (JSON.parse(row.block_reason) as BlockReason)
      : null,
    created_at: normalizeSqliteDatetime(row.created_at),
    updated_at: normalizeSqliteDatetime(row.updated_at),
    agent_id: row.agent_id,
    task: {
      id: row.task_id,
      title: row.task_title,
      priority: row.task_priority,
    },
    session: hydrateSession(row),
    iteration,
  };
}
