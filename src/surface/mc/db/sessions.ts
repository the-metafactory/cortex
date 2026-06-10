/**
 * Grove Mission Control v2 — Session DB helpers.
 */

import type { Database } from "bun:sqlite";
import type { EndpointKind, Session } from "../types";
import { generateId } from "./events";
import { ensureAgentRow } from "./agents";

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
 * The shadow agent is `persistent=1` so principal-visible agent lists that
 * filter on `persistent=1` don't accidentally drop the sentinel; the
 * projection-level filter (`ag.id != 'mc-shadow-agent'`) is the
 * principal-visibility control, not persistence.
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

// ============================================================================
// MC-I1.S5 (ADR-0005 §3) — orphan observed-session auto-registration
// ============================================================================
//
// An ORPHAN is a real instrumented CC session (CORTEX_CHANNEL set — e.g. the
// principal's own `cldyo-live` terminal) that writes raw hook events but was
// NEVER registered with Mission Control: no dispatch, no `POST /api/sessions`,
// so no task/assignment/session row exists for its `cc_session_id`. The
// ingestor used to HARD-DROP these events; ADR-0005 §3 (the catch-all half of
// Phase 1) says auto-register them so the session lights up on the glass.
//
// Storage shape — DECISION (b): synthetic task + per-orphan agent + assignment.
// We reuse the established F-12b pattern (`ensureShadowAgent` +
// `createShadowAssignmentAndSession`) rather than relaxing `sessions.assignment_id`
// to nullable. Rationale:
//   - EVERY read query joins FROM `agent_task_assignment` outward to sessions
//     (`mostRecentSessionLeftJoin`, `listWorkingAgents`, `mostActiveAgent`,
//     the ingestor's own F-20 SELECT). A NULL `assignment_id` with no
//     assignment row would make the orphan session exist but render NOWHERE —
//     it is unreachable through every assignment-anchored join. The synthetic
//     assignment keeps orphans visible through the unchanged join paths.
//   - Zero schema change → zero blast radius on the 20-table schema, no
//     REBUILD_MIGRATIONS, no nullable-column audit across N queries.
//
// Distinguishability: orphan agents carry the `mc-orphan-` id prefix and the
// session is `endpoint_kind = 'local.observed'`, so the dashboard can tell
// them apart from dispatch-spawned controlled sessions. They are PER-orphan
// (one agent + assignment + session per `cc_session_id`), so each instrumented
// terminal is its own working-grid tile rather than collapsing into one.
//
// Lifecycle: the orphan assignment is born `dispatched` so the ingestor's F-20
// auto-transitions drive it normally — `dispatched → running` on the first
// event, `running → completed` on Stop/SessionEnd — exactly like any other
// observed session. Nothing in F-20 needs to special-case orphans.

export const ORPHAN_AGENT_PREFIX = "mc-orphan-";
// Exported so the retention prune anchors on the SAME id (it's a DELETE
// anchor — a silent drift between two copies would break the prune's
// real-row safety guarantee). See db/retention.ts.
export const ORPHAN_TASK_ID = "mc-orphan-task";
const ORPHAN_TASK_TITLE = "Observed sessions (unregistered)";
// Synthetic task needs a principal_id + source_system (both NOT NULL). The task
// is an internal MC bookkeeping row, not a real provider work item.
const ORPHAN_TASK_PRINCIPAL = "mc-orphan";
const ORPHAN_TASK_SOURCE_SYSTEM = "internal";

/**
 * Lazily insert the well-known orphan catch-all task. Idempotent. All orphan
 * assignments hang off this single task (the task is bookkeeping; the agent +
 * assignment + session carry the per-session identity).
 */
function ensureOrphanTask(db: Database): string {
  db.query(
    `INSERT INTO tasks (id, title, priority, principal_id, source_system, status)
     VALUES (?, ?, 2, ?, ?, 'in_progress')
     ON CONFLICT(id) DO NOTHING`
  ).run(ORPHAN_TASK_ID, ORPHAN_TASK_TITLE, ORPHAN_TASK_PRINCIPAL, ORPHAN_TASK_SOURCE_SYSTEM);
  return ORPHAN_TASK_ID;
}

/**
 * Deterministic orphan-agent id for a `cc_session_id`. One agent per orphan
 * session → one working-grid tile per instrumented terminal. The `mc-orphan-`
 * prefix makes orphans distinguishable from dispatch-spawned agents.
 */
export function orphanAgentId(ccSessionId: string): string {
  return `${ORPHAN_AGENT_PREFIX}${ccSessionId}`;
}

/**
 * Lazily insert the per-orphan agent. `displayName` is taken from the raw
 * event's `agent_name` when present, otherwise the cc_session_id — applied
 * only on insert (subsequent events never overwrite a name the principal may
 * have since edited), matching `ensureNamedAgent`'s semantics.
 */
function ensureOrphanAgent(
  db: Database,
  ccSessionId: string,
  displayName: string | undefined
): string {
  const id = orphanAgentId(ccSessionId);
  // Deliberate double-guard with the ingestor's pick (which already skips
  // empty agent_name values): this fallback must hold for ANY caller, not
  // just the ingestor path.
  const name = displayName && displayName.length > 0 ? displayName : ccSessionId;
  // head / non-persistent (per-orphan ephemeral agent). Insert-only name via
  // the shared ensureAgentRow helper (S6 DRY pickup, #861 finding 3).
  return ensureAgentRow(db, { id, name, type: "head", persistent: false });
}

export interface OrphanSession {
  agentId: string;
  assignmentId: string;
  sessionId: string;
}

/**
 * Auto-register an orphan observed session for an unknown `cc_session_id`.
 *
 * Idempotent on `cc_session_id`: if a session row already carries this
 * `cc_session_id` we return null (the caller then proceeds with the existing
 * session — no duplicate task/agent/assignment/session is created). The first
 * call lands the synthetic task (shared), a per-orphan agent, an assignment in
 * `dispatched`, and a `local.observed` session.
 *
 * Wrapped in a single transaction so a partial insert can never leave a
 * dangling agent/assignment without its session.
 *
 * @param displayName  Raw event `agent_name`, surfaced as the orphan agent's
 *                     display name where the schema allows (insert-only).
 */
export function registerOrphanSession(
  db: Database,
  ccSessionId: string,
  displayName?: string
): OrphanSession | null {
  // Dedupe: any existing session for this cc_session_id (orphan or otherwise)
  // means we must NOT create a second one. The ingestor's own lookup already
  // ran and missed, but this guard keeps the helper safe to call directly.
  const existing = db
    .query(`SELECT 1 FROM sessions WHERE cc_session_id = ? LIMIT 1`)
    .get(ccSessionId);
  if (existing) return null;

  const assignmentId = generateId();
  const sessionId = generateId();

  const txn = db.transaction(() => {
    ensureOrphanTask(db);
    const agentId = ensureOrphanAgent(db, ccSessionId, displayName);

    // Born `dispatched` so the ingestor's F-20 auto-transitions
    // (dispatched → running on first event, running → completed on
    // Stop/SessionEnd) drive the orphan exactly like a registered observed
    // session — no orphan-specific lifecycle code needed.
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES (?, ?, ?, 'dispatched')`
    ).run(assignmentId, agentId, ORPHAN_TASK_ID);

    const now = new Date().toISOString();
    db.query(
      `INSERT INTO sessions
         (id, assignment_id, cc_session_id, endpoint_kind, pid, started_at)
       VALUES (?, ?, ?, 'local.observed', NULL, ?)`
    ).run(sessionId, assignmentId, ccSessionId, now);

    return { agentId, assignmentId, sessionId };
  });

  return txn();
}
