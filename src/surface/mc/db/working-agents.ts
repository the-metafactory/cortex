/**
 * Grove Mission Control v2 — Working-agent grid query.
 *
 * Used by GET /api/working-agents to render the dashboard's §8.3 grid
 * (docs/design-mc-f9-working-grid.md). One row per agent with at least
 * one active-non-blocked assignment, folded down to a single "current
 * primary" tile via the F-8 rank table.
 *
 * Kept separate from `tasks.ts` and `assignments.ts` because the shape
 * is agent-keyed rather than task-keyed or assignment-keyed.
 */

import type { Database } from "bun:sqlite";
import { normalizeSqliteDatetime } from "./assignments";
import { SHADOW_AGENT_ID } from "./sessions";

/** The three states that qualify an agent as "working" per Decision 2. */
export type WorkingState = "running" | "dispatched" | "queued";

/**
 * Tile rank — mirrors the F-8 STATE_RANKS table (db/tasks.ts), but the
 * working grid only ever surfaces values 1..3 because `blocked` (0) is
 * filtered out and terminal states (4..6) are excluded.
 */
export type WorkingStateRank = 1 | 2 | 3;

export interface WorkingAgentTile {
  agent_id: string;
  agent_name: string;
  agent_type: "head" | "hands";
  primary_state_rank: WorkingStateRank;
  primary_state: WorkingState;
  primary_assignment: {
    id: string;
    task_id: string;
    task_title: string;
    task_priority: number;
    /** ISO-8601 UTC. */
    updated_at: string;
  };
  /** Count of additional active-non-blocked assignments beyond the primary. */
  additional_active_count: number;
}

/**
 * SQL CASE mapping from state → rank; keep in lockstep with STATE_RANKS.
 *
 * Parametrised on the table alias so the same mapping can be reused in
 * both the outer SELECT (aliased `a`) and the correlated subquery
 * (aliased `aa`) — avoids the two-place-update footgun the named
 * constant was introduced to prevent.
 */
function rankSql(alias: string): string {
  return `
  CASE ${alias}.state
    WHEN 'running'    THEN 1
    WHEN 'dispatched' THEN 2
    WHEN 'queued'     THEN 3
  END`;
}
const WORKING_RANK_SQL = rankSql("a");

interface JoinedRow {
  agent_id: string;
  agent_name: string;
  agent_type: "head" | "hands";
  assignment_id: string;
  state: WorkingState;
  state_rank: WorkingStateRank;
  task_id: string;
  task_title: string;
  task_priority: number;
  updated_at: string;
}

interface CountRow {
  agent_id: string;
  cnt: number;
}

/**
 * List working agents: one tile per agent with ≥ 1 active-non-blocked
 * assignment. Primary assignment is picked by rank ASC, updated_at DESC
 * (matches F-8 Decision 5's primary-active tie-break for drill-down entry).
 *
 * `additional_active_count` is the count of other active-non-blocked
 * assignments the same agent holds (excludes `blocked` and terminal states
 * for consistency with Decision 2).
 *
 * Sort: primary_state_rank ASC, primary_assignment.updated_at DESC
 * (most-active agents first).
 */
export function listWorkingAgents(db: Database): WorkingAgentTile[] {
  // The inner-join subquery picks the best-ranked active-non-blocked
  // assignment per agent. A correlated subquery on (agent_id, rank) would
  // also work but the window-style approach via GROUP BY keeps the plan flat.
  //
  // The min-per-agent selection is expressed as a correlated WHERE clause
  // (`a.id = (SELECT ...)`) rather than a bare GROUP BY, because we need
  // the full assignment row, not aggregates. SQLite plans this as an
  // index-scan over idx_ata_state + small per-agent nested seeks, which is
  // trivial at Phase B fleet size.
  // F-12b Decision 8 — defensive filter: `mc-shadow-agent` never appears
  // on the F-9 working grid. The state filter (`a.state IN ('running',
  // 'dispatched','queued')`) already rejects the shadow assignment (which
  // is `cancelled` from insert), but adding the explicit agent-id filter
  // survives any future bug that flipped the shadow assignment to a
  // non-terminal state. Second line of defense, independent of the state
  // filter.
  const rows = db
    .query(
      `SELECT
         ag.id   AS agent_id,
         ag.name AS agent_name,
         ag.type AS agent_type,
         a.id    AS assignment_id,
         a.state AS state,
         ${WORKING_RANK_SQL} AS state_rank,
         t.id    AS task_id,
         t.title AS task_title,
         t.priority AS task_priority,
         a.updated_at AS updated_at
       FROM agents ag
       JOIN agent_task_assignment a ON a.agent_id = ag.id
       JOIN tasks t ON t.id = a.task_id
       WHERE a.state IN ('running','dispatched','queued')
         AND ag.id != '${SHADOW_AGENT_ID}'
         AND a.id = (
           SELECT aa.id
           FROM agent_task_assignment aa
           WHERE aa.agent_id = ag.id
             AND aa.state IN ('running','dispatched','queued')
           ORDER BY
             ${rankSql("aa")} ASC,
             aa.updated_at DESC,
             aa.id ASC
           LIMIT 1
         )
       ORDER BY state_rank ASC, a.updated_at DESC, ag.id ASC`
    )
    .all() as JoinedRow[];

  if (rows.length === 0) return [];

  // Second query: how many OTHER active-non-blocked assignments does each
  // qualifying agent hold? Counted across the same state partition.
  // `- 1` because the primary counts toward the total; we want "additional".
  const agentIds = rows.map((r) => r.agent_id);
  const placeholders = agentIds.map(() => "?").join(",");
  // `agent_id != 'mc-shadow-agent'` is technically redundant here — the
  // outer query already excludes it and the state filter rejects
  // `cancelled` anyway — but kept for symmetry with the outer SELECT.
  const counts = db
    .query(
      `SELECT agent_id, COUNT(*) AS cnt
       FROM agent_task_assignment
       WHERE state IN ('running','dispatched','queued')
         AND agent_id != '${SHADOW_AGENT_ID}'
         AND agent_id IN (${placeholders})
       GROUP BY agent_id`
    )
    .all(...agentIds) as CountRow[];

  const countByAgent = new Map<string, number>();
  for (const c of counts) countByAgent.set(c.agent_id, c.cnt);

  return rows.map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    agent_type: r.agent_type,
    primary_state_rank: r.state_rank,
    primary_state: r.state,
    primary_assignment: {
      id: r.assignment_id,
      task_id: r.task_id,
      task_title: r.task_title,
      task_priority: r.task_priority,
      updated_at: normalizeSqliteDatetime(r.updated_at),
    },
    additional_active_count: Math.max(0, (countByAgent.get(r.agent_id) ?? 1) - 1),
  }));
}
