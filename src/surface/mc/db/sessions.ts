/**
 * Grove Mission Control v2 — Session DB helpers.
 */

import type { Database } from "bun:sqlite";
import type { EndpointKind, Session } from "../types";
import { generateId } from "./events";
import { ensureAgentRow } from "./agents";

/**
 * The default substrate for a session whose harness is unknown — observed CC
 * hook sessions and any pre-ST-P0 caller. Matches the schema column default and
 * refactor §3 D4 ('claude-code').
 */
export const DEFAULT_SUBSTRATE = "claude-code";

export function createSession(
  db: Database,
  params: {
    assignmentId: string;
    endpointKind: EndpointKind;
    ccSessionId?: string;
    pid?: number;
    // --- ST-P0 / ADR-0011 canonical session columns (all optional this phase;
    // no existing caller passes them — defaults apply and behavior is unchanged). ---
    /** Self-ref to the spawning session; omit for an agent-rooted session. */
    parentSessionId?: string | null;
    /** The substrate; defaults to {@link DEFAULT_SUBSTRATE} ('claude-code'). */
    substrate?: string;
    /** Owning agent id (denormalized). */
    agentId?: string | null;
    /** Owning agent display name (a session is NOT an agent). */
    agentName?: string | null;
    /** Principal the session belongs to (denormalized). */
    principalId?: string | null;
    /** Denormalized lifecycle status. */
    status?: string | null;
    /**
     * CK-4a / #1295 — the stack this session ORIGINATED on. Omit (→ NULL) for
     * own/local-stack origin, the pre-CK-4a / single-stack default. Stamped from
     * the stack's own resolved identity; never from a peer-controlled payload.
     */
    originStackId?: string | null;
  }
): Session {
  const id = generateId();
  const now = new Date().toISOString();
  const substrate = params.substrate ?? DEFAULT_SUBSTRATE;
  const parentSessionId = params.parentSessionId ?? null;
  const agentId = params.agentId ?? null;
  const agentName = params.agentName ?? null;
  const principalId = params.principalId ?? null;
  const status = params.status ?? null;
  const originStackId = params.originStackId ?? null;

  db.query(
    `INSERT INTO sessions
       (id, assignment_id, cc_session_id, endpoint_kind, pid, started_at,
        parent_session_id, substrate, agent_id, agent_name, principal_id, status,
        origin_stack_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.assignmentId,
    params.ccSessionId ?? null,
    params.endpointKind,
    params.pid ?? null,
    now,
    parentSessionId,
    substrate,
    agentId,
    agentName,
    principalId,
    status,
    originStackId
  );

  return {
    id,
    assignment_id: params.assignmentId,
    cc_session_id: params.ccSessionId ?? null,
    endpoint_kind: params.endpointKind,
    pid: params.pid ?? null,
    started_at: now,
    ended_at: null,
    parent_session_id: parentSessionId,
    substrate,
    agent_id: agentId,
    agent_name: agentName,
    principal_id: principalId,
    status,
    duration_ms: null,
    events_count: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cost_usd: null,
    classification: null,
    data_residency: null,
    home_principal: null,
    origin_stack_id: originStackId,
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
  parent_session_id: string | null;
  substrate: string;
  agent_id: string | null;
  agent_name: string | null;
  principal_id: string | null;
  status: string | null;
  duration_ms: number | null;
  events_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cost_usd: number | null;
  classification: string | null;
  data_residency: string | null;
  home_principal: string | null;
  origin_stack_id: string | null;
}

/**
 * Single source of truth for mapping a `sessions` row → {@link Session}. Keeps
 * the SELECT column list and the object shape in lockstep as the canonical
 * columns grow (ST-P0 / ADR-0011). Callers that SELECT a partial row must pass a
 * full row through here, so prefer {@link SESSION_SELECT_COLUMNS}.
 */
export function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    assignment_id: row.assignment_id,
    cc_session_id: row.cc_session_id,
    endpoint_kind: row.endpoint_kind,
    pid: row.pid,
    started_at: row.started_at,
    ended_at: row.ended_at,
    parent_session_id: row.parent_session_id,
    substrate: row.substrate,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    principal_id: row.principal_id,
    status: row.status,
    duration_ms: row.duration_ms,
    events_count: row.events_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cost_usd: row.cost_usd,
    classification: row.classification,
    data_residency: row.data_residency,
    home_principal: row.home_principal,
    origin_stack_id: row.origin_stack_id,
  };
}

/** Canonical SELECT column list for a full {@link Session} row mapping. */
export const SESSION_SELECT_COLUMNS = `id, assignment_id, cc_session_id, endpoint_kind, pid,
        started_at, ended_at, parent_session_id, substrate, agent_id, agent_name,
        principal_id, status, duration_ms, events_count, input_tokens, output_tokens,
        cache_read_tokens, cost_usd, classification, data_residency, home_principal,
        origin_stack_id`;

/**
 * CK-4a / #1295 / decision D-8 — value-level backfill of `origin_stack_id`.
 *
 * The COLUMN_ADD_MIGRATIONS ALTER (db/schema.ts) only ADDS the column (NULL for
 * every pre-existing row). This stamps the daemon's OWN resolved `stackId` onto
 * the rows that predate origin attribution — the sessions this stack produced
 * itself, which by definition originate here. Scoped to `origin_stack_id IS NULL`
 * so it is idempotent (re-running is a no-op) and NEVER overwrites a value already
 * attributed to a specific origin (a peer stack's rows in an aggregating MC-DB, or
 * a value a later write already stamped) — that would corrupt cross-stack grouping.
 *
 * Kept out of the schema migration on purpose: the schema layer does not know the
 * resolved stack id (it lives in config, wired at daemon boot), so the id-aware
 * backfill is a caller-invoked step. The boot wiring that calls this with the
 * resolved stack id is the CK-4a write-half (server/runner scope) — deliberately
 * NOT wired here (the CK-4a scope keeps `server.ts` untouched).
 *
 * Returns the number of rows stamped.
 */
export function backfillOriginStackId(db: Database, stackId: string): number {
  const info = db
    .query(`UPDATE sessions SET origin_stack_id = ? WHERE origin_stack_id IS NULL`)
    .run(stackId);
  return info.changes;
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
      `SELECT ${SESSION_SELECT_COLUMNS}
       FROM sessions
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(assignmentId) as SessionRow | null;

  if (!row) return null;

  return rowToSession(row);
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
// Observed-session auto-registration (MC-I1.S5 → ST-P2 owning-agent model)
// ============================================================================
//
// An ORPHAN is a real instrumented CC session (CORTEX_CHANNEL set — e.g. the
// principal's own `cldyo-live` terminal, or any Claude-Code-`Agent`-tool child)
// that writes raw hook events but was NEVER registered with Mission Control: no
// dispatch, no `POST /api/sessions`, so no task/assignment/session row exists
// for its `cc_session_id`. The ingestor used to HARD-DROP these events;
// ADR-0005 §3 auto-registers them so the session lights up on the glass.
//
// ── ST-P2: sessions, not agents (the 1,044-tile fix) ────────────────────────
// The S5 model minted ONE `agents` row per `cc_session_id` (`mc-orphan-{uuid}`).
// An overnight autonomous run is a deep recursive tree of ~1,000 sessions, so
// that flattened the whole tree into 1,044 sibling "agent" tiles
// (docs/refactor-mc-session-tree.md §1, D2). A session is NOT an agent.
//
// New model (refactor D2): an observed session is a SESSION belonging to the
// REAL owning agent — the wrapper identity carried on the event (e.g. 'luna' /
// 'andreas'). `ensureAgentRow` keeps ONE real agent row per distinct observed
// identity (that IS an agent), NEVER one per `cc_session_id`. The observed
// display name is stored on the session's canonical `agent_name` column.
//
// Why the working grid collapses 1,044 → 1: `listWorkingAgents` is agent-keyed
// (`FROM agents JOIN agent_task_assignment … AND a.id = (SELECT … LIMIT 1)` →
// one tile per agent). Once every observed session's assignment points at the
// SAME real agent, that agent folds to a SINGLE tile regardless of how many
// sessions hang off it. The session tree under it is Phase 4's projection.
//
// Synthetic assignment (refactor D3): the `sessions.assignment_id NOT NULL` FK
// and the partial unique index `idx_sessions_active_assignment (assignment_id)
// WHERE ended_at IS NULL` (at most one OPEN session per assignment) force a
// PER-SESSION assignment row — but, per D3, it now points at the REAL owning
// agent, not a per-session synthetic one. We keep the synthetic task +
// assignment mechanics short-term (zero blast radius on the assignment-anchored
// read joins); they retire once reads are fully session-anchored. The shared
// `mc-orphan-task` stays the bookkeeping anchor for AUTO-registered observed
// sessions — the one predicate that distinguishes them from principal-dispatch
// work (which never uses this task) for the retention reaper (db/retention.ts).
//
// Lifecycle: the assignment is born `dispatched` so the ingestor's F-20
// auto-transitions drive it normally — `dispatched → running` on the first
// event, `running → completed` on Stop/SessionEnd. Nothing in F-20 special-cases
// orphans.

// Retained ONLY for legacy-row compatibility in the retention prune/reaper:
// pre-ST-P2 DBs still hold `mc-orphan-{uuid}` agent rows the reaper must keep
// sweeping. No NEW row is ever minted with this prefix. See db/retention.ts.
export const ORPHAN_AGENT_PREFIX = "mc-orphan-";
// Exported so the retention prune/reaper anchors on the SAME id (it's a DELETE/
// reap anchor — a silent drift between two copies would break the prune's
// real-row safety guarantee). The orphan task is the bookkeeping anchor that
// distinguishes auto-registered observed sessions (which hang off it) from real
// dispatch work (which never does). See db/retention.ts.
export const ORPHAN_TASK_ID = "mc-orphan-task";
const ORPHAN_TASK_TITLE = "Observed sessions (unregistered)";
// Synthetic task needs a principal_id + source_system (both NOT NULL). The task
// is an internal MC bookkeeping row, not a real provider work item.
const ORPHAN_TASK_PRINCIPAL = "mc-orphan";
const ORPHAN_TASK_SOURCE_SYSTEM = "internal";

/**
 * Stable id prefix for an observed session's OWNING agent when the event
 * carries no wrapper `agent_id`. We derive it from the display name (slugged)
 * so distinct named identities still fold to one tile each, and fall back to
 * the cc_session_id ONLY when there is no identity at all (a truly anonymous
 * observed session — the rare worst case, still ONE agent for that session, not
 * the old per-cc_session_id-with-`head`-type flood since it carries no name).
 */
const OBSERVED_AGENT_PREFIX = "observed:";

/**
 * Lazily insert the well-known orphan catch-all task. Idempotent. All
 * auto-registered observed assignments hang off this single task (the task is
 * bookkeeping; the REAL owning agent + the session carry identity).
 */
function ensureOrphanTask(db: Database): string {
  db.query(
    `INSERT INTO tasks (id, title, priority, principal_id, source_system, status)
     VALUES (?, ?, 2, ?, ?, 'in_progress')
     ON CONFLICT(id) DO NOTHING`
  ).run(ORPHAN_TASK_ID, ORPHAN_TASK_TITLE, ORPHAN_TASK_PRINCIPAL, ORPHAN_TASK_SOURCE_SYSTEM);
  return ORPHAN_TASK_ID;
}

/** Slug a display name into an id-safe token (lowercase, non-alnum → '-'). */
function slugifyIdentity(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve the OWNING agent id for an observed session (ST-P2, refactor D2).
 *
 * Resolution order (most → least authoritative):
 *   1. `agentId` — the wrapper identity carried on the event (`CORTEX_AGENT_ID`,
 *      e.g. 'luna' / 'andreas'). This IS the real agent. ONE per distinct
 *      identity → ONE working-grid tile.
 *   2. `observed:{slug(displayName)}` — when only a display name is known
 *      (`CORTEX_AGENT_NAME` with no id). Distinct named identities still fold to
 *      one agent each.
 *   3. `observed:{ccSessionId}` — last resort for a truly anonymous observed
 *      session. One agent for that one session (NOT a recurring per-spawn flood,
 *      because a real instrumented run carries an identity at #1/#2).
 *
 * NEVER returns the legacy `mc-orphan-{cc}` shape — that minted one agent per
 * session, the bug ST-P2 fixes.
 */
export function resolveOwningAgentId(
  ccSessionId: string,
  agentId: string | undefined,
  displayName: string | undefined
): string {
  if (agentId && agentId.trim().length > 0) return agentId.trim();
  if (displayName && displayName.trim().length > 0) {
    const slug = slugifyIdentity(displayName);
    if (slug.length > 0) return `${OBSERVED_AGENT_PREFIX}${slug}`;
  }
  return `${OBSERVED_AGENT_PREFIX}${ccSessionId}`;
}

export interface OrphanSession {
  agentId: string;
  assignmentId: string;
  sessionId: string;
}

/** Identity + tree metadata captured off the raw event for an observed session. */
export interface ObservedSessionInput {
  /** Wrapper agent id off the event (`CORTEX_AGENT_ID`); resolves the owning agent. */
  agentId?: string;
  /** Display name (`CORTEX_AGENT_NAME` / event `agent_name`); stored on the session. */
  displayName?: string;
  /** Substrate (event payload `substrate`); defaults to {@link DEFAULT_SUBSTRATE}. */
  substrate?: string;
  /** Parent session id (event payload `parent_session_id` or prompt-correlation). */
  parentSessionId?: string | null;
}

/**
 * Auto-register an observed session for an unknown `cc_session_id` (ST-P2).
 *
 * The session attaches to the REAL owning agent (resolved via
 * {@link resolveOwningAgentId}) — NOT a per-session synthetic agent. The display
 * name lands on the session's canonical `agent_name` column; substrate +
 * parent_session_id are set when known. The synthetic assignment (anchored on
 * the shared `mc-orphan-task`) points at the real agent (refactor D3).
 *
 * Idempotent on `cc_session_id`: if a session row already carries this
 * `cc_session_id` we return null (the caller proceeds with the existing
 * session). The first call ensures the shared task + the REAL owning agent
 * (insert-only name), an assignment in `dispatched`, and a `local.observed`
 * session carrying the canonical columns.
 *
 * Wrapped in a single transaction so a partial insert can never leave a
 * dangling assignment without its session.
 */
export function registerOrphanSession(
  db: Database,
  ccSessionId: string,
  input?: ObservedSessionInput
): OrphanSession | null {
  // Dedupe: any existing session for this cc_session_id (orphan or otherwise)
  // means we must NOT create a second one. The ingestor's own lookup already
  // ran and missed, but this guard keeps the helper safe to call directly.
  const existing = db
    .query(`SELECT 1 FROM sessions WHERE cc_session_id = ? LIMIT 1`)
    .get(ccSessionId);
  if (existing) return null;

  const assignmentId = generateId();
  const agentId = resolveOwningAgentId(ccSessionId, input?.agentId, input?.displayName);
  // Display name stored on the session (a session is NOT an agent). Fall back to
  // the resolved agentId so a card never shows an empty label.
  const displayName =
    input?.displayName && input.displayName.length > 0 ? input.displayName : agentId;

  const txn = db.transaction(() => {
    ensureOrphanTask(db);
    // ONE real agent per distinct observed identity (insert-only name via the
    // shared helper). `head` (it runs a session); persistent so a re-observed
    // identity keeps its principal-edited name. NOT the old per-session agent.
    ensureAgentRow(db, { id: agentId, name: displayName, type: "head", persistent: true });

    // Born `dispatched` so the ingestor's F-20 auto-transitions drive it like
    // any observed session. The assignment points at the REAL agent (D3).
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES (?, ?, ?, 'dispatched')`
    ).run(assignmentId, agentId, ORPHAN_TASK_ID);

    // Insert the SESSION via the canonical createSession path so the
    // denormalized columns (agent_id, agent_name, substrate, parent_session_id)
    // are written in lockstep with the schema.
    const session = createSession(db, {
      assignmentId,
      endpointKind: "local.observed",
      ccSessionId,
      agentId,
      agentName: displayName,
      substrate: input?.substrate ?? DEFAULT_SUBSTRATE,
      parentSessionId: input?.parentSessionId ?? null,
    });

    return { agentId, assignmentId, sessionId: session.id };
  });

  return txn();
}
