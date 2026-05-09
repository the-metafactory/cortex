/**
 * Grove Mission Control v2 — Session DB helpers.
 */

import type { Database } from "bun:sqlite";
import type { EndpointKind, Session } from "../types";
import { generateId } from "./events";

export function createSession(
  db: Database,
  params: {
    assignmentId: string;
    endpointKind: EndpointKind;
    ccSessionId?: string;
    pid?: number;
  }
): Session {
  const id = generateId();
  const now = new Date().toISOString();

  db.query(
    `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind, pid, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.assignmentId,
    params.ccSessionId ?? null,
    params.endpointKind,
    params.pid ?? null,
    now
  );

  return {
    id,
    assignment_id: params.assignmentId,
    cc_session_id: params.ccSessionId ?? null,
    endpoint_kind: params.endpointKind,
    pid: params.pid ?? null,
    started_at: now,
    ended_at: null,
  };
}

interface SessionRow {
  id: string;
  assignment_id: string;
  cc_session_id: string | null;
  endpoint_kind: EndpointKind;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Shared lookup for the most-recent session of an assignment. `activeOnly`
 * toggles between "latest open session" (for controllable-endpoint resolution)
 * and "latest session regardless of ended_at" (for the F-7 drill-down, which
 * must keep showing events after a turn ends).
 *
 * Single source of truth for the SELECT columns + row→Session mapping —
 * prevents drift when sessions grows a new column.
 */
function findSession(
  db: Database,
  assignmentId: string,
  opts: { activeOnly: boolean }
): Session | null {
  const whereClause = opts.activeOnly
    ? `WHERE assignment_id = ? AND ended_at IS NULL`
    : `WHERE assignment_id = ?`;
  const row = db
    .query(
      `SELECT id, assignment_id, cc_session_id, endpoint_kind, pid,
              started_at, ended_at
       FROM sessions
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(assignmentId) as SessionRow | null;

  if (!row) return null;

  return {
    id: row.id,
    assignment_id: row.assignment_id,
    cc_session_id: row.cc_session_id,
    endpoint_kind: row.endpoint_kind,
    pid: row.pid,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

export function findActiveSession(
  db: Database,
  assignmentId: string
): Session | null {
  return findSession(db, assignmentId, { activeOnly: true });
}

export function endSession(db: Database, sessionId: string): void {
  const now = new Date().toISOString();
  db.query(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(now, sessionId);
}

/**
 * Find the most recent session for an assignment, whether active or ended.
 * F-7 drill-down uses this: the attention view must still show events after
 * a turn ends (ended_at IS NOT NULL) until the next dispatch cycle begins.
 */
export function findLatestSessionForAssignment(
  db: Database,
  assignmentId: string
): Session | null {
  return findSession(db, assignmentId, { activeOnly: false });
}

// ============================================================================
// F-12b — shadow agent / assignment / session helper
// ============================================================================
//
// Decisions referenced inline (`docs/design-mc-f12b-add-to-queue.md`):
//   D8  — `task-shadow-{taskId}` synthetic-session pattern. Shadow assignment
//         is `cancelled` from insert; shadow session has endpoint_kind
//         `local.observed` with `ended_at` set immediately.
//   D7  — `mc-shadow-agent` is the sentinel id the dashboard's
//         `resolveDrillInputMode` keys off to pick the "shadow" input mode.
//
// The helper threads the `sessions.assignment_id NOT NULL REFERENCES
// agent_task_assignment(id)` FK by creating a synthetic assignment row
// first, then attaching the shadow session to it.

export const SHADOW_AGENT_ID = "mc-shadow-agent";
const SHADOW_AGENT_NAME = "Mission Control shadow";

/**
 * Lazily insert the well-known shadow agent row if missing. Idempotent.
 * Sibling of `ensureDefaultAgent` in `api/handlers.ts`.
 *
 * The shadow agent is `persistent=1` so operator-visible agent lists that
 * filter on `persistent=1` don't accidentally drop the sentinel; the
 * projection-level filter (`ag.id != 'mc-shadow-agent'`) is the
 * operator-visibility control, not persistence.
 */
export function ensureShadowAgent(db: Database): string {
  db.query(
    `INSERT INTO agents (id, name, type, persistent)
     VALUES (?, ?, 'hands', 1)
     ON CONFLICT(id) DO NOTHING`
  ).run(SHADOW_AGENT_ID, SHADOW_AGENT_NAME);
  return SHADOW_AGENT_ID;
}

/**
 * Create the shadow assignment + session pair for a newly-created F-12b
 * task. Returns the two ids so the caller can include them in the create
 * response and anchor the curation event on the session.
 *
 * Invariants:
 *   - Shadow assignment state is `'cancelled'` from insert. The CHECK
 *     constraint `(state = 'blocked') = (block_reason IS NOT NULL)` on
 *     `agent_task_assignment` holds because both sides evaluate false.
 *   - Shadow session has `endpoint_kind = 'local.observed'` and
 *     `ended_at` populated immediately. This makes the partial unique
 *     index `idx_sessions_active_assignment` trivially satisfied for the
 *     shadow row, so a future real controlled session for the same task
 *     (pointing at a different assignment row) never collides.
 *
 * Must run inside a transaction that also inserts the task row — the
 * caller (`handleCreateTask`) wraps all four INSERTs in one
 * `db.transaction`.
 */
export function createShadowAssignmentAndSession(
  db: Database,
  taskId: string,
  ids: { assignmentId: string; sessionId: string }
): { shadowAssignmentId: string; shadowSessionId: string } {
  ensureShadowAgent(db);

  db.query(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
     VALUES (?, ?, ?, 'cancelled')`
  ).run(ids.assignmentId, SHADOW_AGENT_ID, taskId);

  const now = new Date().toISOString();
  db.query(
    `INSERT INTO sessions
       (id, assignment_id, cc_session_id, endpoint_kind, pid, started_at, ended_at)
     VALUES (?, ?, NULL, 'local.observed', NULL, ?, ?)`
  ).run(ids.sessionId, ids.assignmentId, now, now);

  return {
    shadowAssignmentId: ids.assignmentId,
    shadowSessionId: ids.sessionId,
  };
}
