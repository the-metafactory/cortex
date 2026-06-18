/**
 * MC-I1.S4 (ADR-0005 §3 + §4) — project `dispatch.task.*` lifecycle envelopes
 * into Mission Control session/assignment/task rows.
 *
 * ADR-0005 §3 ("Session rows are projected from the bus") assigns Mission
 * Control the dispatch-sink role: the runner stamps `cc_session_id` onto the
 * lifecycle envelopes (S3, #852) and MC projects them into rows so
 * dispatch-spawned work appears live on the working grid. §4 makes the bus→MC
 * seam a registered surface-router renderer (`project(envelope)` push) rather
 * than a polled ring buffer.
 *
 * This module is the projection itself — pure-ish `(db, envelope)` functions,
 * no bus / HTTP / NATS imports. The renderer that pushes envelopes here lives
 * in `dispatch-lifecycle-renderer.ts`; cortex.ts registers it with the
 * surface-router when `mc.enabled`.
 *
 * ## The cc_session_id timing contract (#846 design comment, S3 #852)
 *
 * The claude-code harness yields `dispatch.task.started` BEFORE it spawns the
 * CC process (so the lifecycle envelope survives a synchronous spawn failure),
 * so on a FRESH dispatch the CC session id is structurally unknown at started.
 * `cc_session_id` is authoritative on the TERMINAL envelope
 * (`completed|failed|aborted`, from `CCSessionResult.sessionId`); `started`
 * carries it only on RESUME (the prior session's id, which may diverge from the
 * post-resume id). Therefore:
 *
 *   - the session row is created from `started` keyed by `correlation_id`
 *     (cc_session_id PENDING — or stamped PROVISIONALLY from a resume id), and
 *   - the authoritative cc_session_id is BACKFILLED when the terminal envelope
 *     arrives, overwriting a provisional resume id if it diverged.
 *
 * Keying the session on `correlation_id` (NOT cc_session_id) at creation time
 * is the load-bearing decision: all four lifecycle envelopes for one task share
 * one `correlation_id`, so the projection always finds its own anchor, while the
 * cc_session_id only becomes the ingestor-join key once the terminal stamps it.
 *
 * ## Anchor shape (follows the S5 synthetic-anchor pattern, dispatch-flavored)
 *
 * Mirroring `registerOrphanSession` (db/sessions.ts):
 *   - one MC `task` per dispatch correlation_id (deterministic id), titled from
 *     the dispatched agent — the lifecycle envelopes carry NO human description
 *     (`DispatchTaskReceivedPayload.prompt` is NOT echoed onto lifecycle
 *     payloads), so `agent_id` is the only label available;
 *   - the dispatched `agent` row (`payload.agent_id` → MC agents);
 *   - an `agent_task_assignment` born `dispatched`, driven `running` on started;
 *   - a `session` row keyed (indirectly, via task→assignment→session) on the
 *     correlation_id, `endpoint_kind = 'local.process.controlled'` (dispatch
 *     spawns are controlled, distinguishing them from S5's `local.observed`
 *     orphans).
 *
 * ## Orphan reconciliation (the dedup the slice brief calls CRITICAL)
 *
 * If hook events race ahead of the terminal envelope, S5's ingestor
 * auto-registers the cc_session_id as a `local.observed` ORPHAN session
 * (its own task/agent/assignment). When the terminal envelope then arrives
 * carrying that same cc_session_id, naively backfilling it onto the projected
 * session would violate the partial unique index
 * `idx_sessions_active_cc_session_id` (≤ 1 OPEN session per cc_session_id).
 *
 * DIRECTION (stated in the PR): ADOPT the orphan session INTO the projected
 * assignment. We re-point `sessions.assignment_id` of the orphan row to the
 * projected assignment (O(1) — the orphan's hook events follow via the
 * `events.session_id → sessions.id` FK, no event re-write), drop the now-empty
 * projected placeholder session, transition the projected assignment, and
 * delete the orphan's emptied assignment. This is cheaper than re-pointing N
 * events and preserves every HOOK event (they ride the orphan session's FK).
 * What is NOT preserved verbatim: the placeholder's own `state.transition`
 * events CASCADE away with its DELETE, and `driveToTerminal` re-synthesizes
 * the start→terminal pair on the adopted row at TERMINAL-time timestamps —
 * transition history is reconstructed, not carried over. The orphan's shared
 * catch-all task/agent are bookkeeping and left in place (idempotent, shared).
 */

import type { Database } from "bun:sqlite";

import { generateId } from "../db/events";
import { ensureAgentRow } from "../db/agents";
import { applyTransition } from "../db/transitions";
import {
  anchorTaskId,
  parseSliceThread,
  linkAnchorToSliceWorkItem,
} from "./anchor";
import type { AssignmentState } from "../types";

/**
 * The four `dispatch.task.*` lifecycle kinds this projection handles. Keyed by
 * the trailing segment of `envelope.type` (`dispatch.task.<kind>`). S6 (#848)
 * extends the seam to verdicts / attention / heartbeats; this set stays the
 * dispatch-lifecycle slice's scope.
 */
type LifecycleKind = "started" | "completed" | "failed" | "aborted";

/** Terminal kinds carry the AUTHORITATIVE cc_session_id and a terminal state. */
const TERMINAL_ACTION: Record<
  Exclude<LifecycleKind, "started">,
  "complete" | "fail" | "cancel"
> = {
  completed: "complete",
  failed: "fail",
  aborted: "cancel",
};

/**
 * Minimal view of the lifecycle payload the projection reads. The lifecycle
 * envelopes carry `task_id`, `agent_id`, and (optionally) `cc_session_id`; no
 * human description rides the wire (see module docblock).
 */
interface LifecyclePayload {
  task_id?: unknown;
  agent_id?: unknown;
  cc_session_id?: unknown;
  // Slice convergence A→C: the slice address echoed onto every lifecycle
  // envelope. `response_routing.thread` is the channel-routing `{repo}/issue/N`
  // form; §C resolves it to the issue's work_item and links the anchor task.
  response_routing?: unknown;
}

/**
 * Read `payload.response_routing.thread` as a slice address (`{repo}/issue/N`).
 * Returns null for any envelope without a parseable issue thread — the
 * backward-compatible no-`response_routing` path (behaviour unchanged: no
 * work_item link). Structural read; mirrors `readLogicalRouting` in
 * `src/adapters/response-routing-delivery.ts` (kept local so the projection
 * stays import-free of the adapter layer).
 */
function readSliceThread(payload: LifecyclePayload): string | undefined {
  const raw = payload.response_routing;
  if (raw === null || typeof raw !== "object") return undefined;
  const thread = (raw as Record<string, unknown>).thread;
  return typeof thread === "string" ? thread : undefined;
}

/** A read of the projected session for a correlation_id, via the anchor task. */
interface ProjectedSessionRow {
  sessionId: string;
  assignmentId: string;
  ccSessionId: string | null;
}

/**
 * The minimal envelope shape the projection reads — kept structural (not the
 * full `Envelope` import) so the renderer can hand any validated envelope here.
 */
export interface ProjectableEnvelope {
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface ProjectionResult {
  /** The lifecycle kind that was projected. */
  kind: LifecycleKind;
  /** Correlation id used as the projection anchor. */
  correlationId: string;
  /** MC session row id the projection landed on. */
  sessionId: string;
  /** MC assignment row id. */
  assignmentId: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Project one `dispatch.task.*` lifecycle envelope into MC rows.
 *
 * Returns `null` (a no-op) for any envelope that is NOT a recognised
 * `dispatch.task.{started|completed|failed|aborted}` — the renderer subscribes
 * broadly and this is the authoritative type filter. Also returns `null` when
 * the payload is malformed (missing `task_id`/`agent_id`) so a bad publisher
 * can't create half-formed anchors.
 *
 * Idempotent on `correlation_id`: a redelivered `started` reuses the existing
 * anchor; a redelivered terminal re-applies the (already-terminal) transition
 * harmlessly (the state machine rejects the redundant move, which we tolerate).
 */
export function projectDispatchLifecycle(
  db: Database,
  envelope: ProjectableEnvelope,
): ProjectionResult | null {
  const kind = lifecycleKind(envelope.type);
  if (kind === null) return null;

  // Defensive read: the schema makes `payload` a non-null object, but a
  // malformed envelope that slipped the validator (or a renderer handing us a
  // hand-built object) could carry a non-object payload. Treat anything
  // non-object as "no fields", so `asString` below returns null and we ignore
  // the envelope rather than throwing on a property access of null.
  const rawPayload: unknown = envelope.payload;
  const payload: LifecyclePayload =
    typeof rawPayload === "object" && rawPayload !== null ? rawPayload : {};
  const taskId = asString(payload.task_id);
  const agentId = asString(payload.agent_id);
  if (taskId === null || agentId === null) {
    process.stderr.write(
      `[mission-control] dispatch-projection: ignoring ${envelope.type} — missing task_id/agent_id\n`,
    );
    return null;
  }

  // The lifecycle envelopes share one correlation_id; fall back to task_id
  // (the builder's default) when the field is absent on the wire.
  const correlationId = envelope.correlation_id ?? taskId;
  const ccSessionId = asString(payload.cc_session_id);
  // Slice convergence C: the slice address (if any) the anchor task links to.
  // Parsed once here; a non-issue / absent thread → null → no work_item link
  // (backward compatible). A FEDERATED dispatch carries the same address and is
  // NOT special-cased — its anchor links to the work_item too, carrying
  // lifecycle only (no interior, which is never projected from a peer).
  const sliceRef = parseSliceThread(readSliceThread(payload));

  // Everything below runs in ONE transaction: anchor creation, transition, and
  // (for terminal) cc_session_id backfill + orphan reconciliation must be
  // atomic so a partial write can't leave a dangling row or a double cc_session.
  const txn = db.transaction((): ProjectionResult => {
    // Idempotently ensure the anchor (task + agent + assignment + session).
    const anchor = ensureAnchor(db, {
      correlationId,
      taskId,
      agentId,
      // started on a RESUME may stamp the prior session's id provisionally;
      // a fresh dispatch's started carries no id (pending).
      provisionalCcSessionId: kind === "started" ? ccSessionId : null,
    });

    // Slice convergence C — link the per-dispatch anchor task to the slice's
    // issue work_item. Runs on EVERY lifecycle kind (idempotent create-if-absent
    // + UPDATE) so a terminal-first delivery (lost `started`) still links, and a
    // redelivery is harmless. No-op when the dispatch carries no issue thread.
    if (sliceRef !== null) {
      linkAnchorToSliceWorkItem(db, correlationId, sliceRef);
    }

    if (kind === "started") {
      // Drive the assignment dispatched → running so the working grid shows the
      // session as active. Idempotent: a redelivered started finds the
      // assignment already `running` and the transition is a no-op (the state
      // machine rejects start-from-running; we tolerate that).
      driveTo(db, anchor.assignmentId, anchor.sessionId, "start");
      return {
        kind,
        correlationId,
        sessionId: anchor.sessionId,
        assignmentId: anchor.assignmentId,
      };
    }

    // Terminal kinds: backfill the AUTHORITATIVE cc_session_id, reconcile any
    // S5 orphan that already holds it, then transition to the terminal state.
    let sessionId = anchor.sessionId;
    if (ccSessionId !== null) {
      sessionId = backfillCcSessionId(db, {
        projectedSessionId: anchor.sessionId,
        projectedAssignmentId: anchor.assignmentId,
        ccSessionId,
      });
    }

    // A terminal envelope can arrive before the assignment ever reached
    // `running` (lost/reordered `started`). Walk it forward through the legal
    // path so the terminal transition is always valid.
    driveToTerminal(db, anchor.assignmentId, sessionId, TERMINAL_ACTION[kind]);

    return {
      kind,
      correlationId,
      sessionId,
      assignmentId: anchor.assignmentId,
    };
  });

  return txn();
}

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

// The deterministic anchor-task id (`ANCHOR_TASK_PREFIX` + `anchorTaskId`) is
// shared via `./anchor` so the verdict + heartbeat projections join the SAME
// anchor (#862 review cheap-fold 1). The constants below are dispatch-lifecycle-
// local bookkeeping for the anchor task ROW the projection writes.
const ANCHOR_TASK_PRINCIPAL = "mc-dispatch";
const ANCHOR_TASK_SOURCE_SYSTEM = "internal";
const CONTROLLED_ENDPOINT = "local.process.controlled";

interface AnchorParams {
  correlationId: string;
  taskId: string;
  agentId: string;
  /** Provisional cc id from a resume `started`, or null (pending). */
  provisionalCcSessionId: string | null;
}

/**
 * Idempotently create (or find) the projection anchor for a correlation_id:
 * a per-dispatch MC task, the dispatched agent row, an assignment born
 * `dispatched`, and a controlled session. Re-finds the existing anchor on a
 * redelivered envelope so the projection never duplicates rows.
 */
function ensureAnchor(
  db: Database,
  params: AnchorParams,
): { sessionId: string; assignmentId: string } {
  // Fast path: anchor already exists for this correlation_id.
  const existing = findProjectedSession(db, params.correlationId);
  if (existing) {
    // A provisional resume cc id can land on a session that was created without
    // one (e.g. the terminal raced the started). Stamp it only if still pending
    // — the terminal backfill remains authoritative.
    if (
      params.provisionalCcSessionId !== null &&
      existing.ccSessionId === null
    ) {
      setProvisionalCcSessionId(
        db,
        existing.sessionId,
        params.provisionalCcSessionId,
      );
    }
    return {
      sessionId: existing.sessionId,
      assignmentId: existing.assignmentId,
    };
  }

  // Create the anchor task (one per dispatch). Bookkeeping row, not a real
  // provider work item — same shape as S5's orphan catch-all task.
  const taskRowId = anchorTaskId(params.correlationId);
  db.query(
    `INSERT INTO tasks (id, title, priority, principal_id, source_system, status)
     VALUES (?, ?, 2, ?, ?, 'in_progress')
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    taskRowId,
    `Dispatched task (${params.agentId})`,
    ANCHOR_TASK_PRINCIPAL,
    ANCHOR_TASK_SOURCE_SYSTEM,
  );

  // The dispatched agent. `head` type (it runs a task), persistent — insert-only
  // name via the shared ensureAgentRow helper (S6 DRY pickup, #861 finding 3) so
  // a principal-edited display name is never overwritten, matching ensureNamedAgent.
  ensureAgentRow(db, {
    id: params.agentId,
    name: params.agentId,
    type: "head",
    persistent: true,
  });

  const assignmentId = generateId();
  const sessionId = generateId();
  const now = new Date().toISOString();

  // Assignment born `dispatched` — the started projection drives it to running;
  // a terminal-first delivery walks it forward via the legal path.
  db.query(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
     VALUES (?, ?, ?, 'dispatched')`,
  ).run(assignmentId, params.agentId, taskRowId);

  // Controlled session — dispatch spawns are controlled, distinguishing them
  // from S5's local.observed orphans. cc_session_id is the provisional resume
  // id when present, else NULL (pending until the terminal backfills it).
  db.query(
    `INSERT INTO sessions
       (id, assignment_id, cc_session_id, endpoint_kind, pid, started_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(
    sessionId,
    assignmentId,
    params.provisionalCcSessionId,
    CONTROLLED_ENDPOINT,
    now,
  );

  return { sessionId, assignmentId };
}

/**
 * Find the projection's session for a correlation_id via the deterministic
 * anchor task → its non-cancelled assignment → most-recent session. Returns the
 * session + assignment + current cc_session_id, or null when no anchor exists.
 */
function findProjectedSession(
  db: Database,
  correlationId: string,
): ProjectedSessionRow | null {
  const row = db
    .query(
      `SELECT s.id AS session_id, s.assignment_id AS assignment_id,
              s.cc_session_id AS cc_session_id
       FROM agent_task_assignment a
       JOIN sessions s ON s.assignment_id = a.id
       WHERE a.task_id = ?
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT 1`,
    )
    .get(anchorTaskId(correlationId)) as
    | { session_id: string; assignment_id: string; cc_session_id: string | null }
    | null;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    assignmentId: row.assignment_id,
    ccSessionId: row.cc_session_id,
  };
}

function setProvisionalCcSessionId(
  db: Database,
  sessionId: string,
  ccSessionId: string,
): void {
  db.query(`UPDATE sessions SET cc_session_id = ? WHERE id = ?`).run(
    ccSessionId,
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// cc_session_id backfill + orphan reconciliation
// ---------------------------------------------------------------------------

interface BackfillParams {
  projectedSessionId: string;
  projectedAssignmentId: string;
  ccSessionId: string;
}

/**
 * Backfill the AUTHORITATIVE cc_session_id onto the projected session, after
 * reconciling any S5 orphan that already holds it.
 *
 * Returns the session id the projection should regard as canonical going
 * forward (the projected session in the no-orphan path; still the projected
 * session in the orphan path — we adopt the orphan's events ONTO the projected
 * assignment's session, see below).
 */
function backfillCcSessionId(db: Database, params: BackfillParams): string {
  const orphan = findReconcilableOrphan(db, params);

  if (orphan === null) {
    // No competing row — straight backfill (overwriting a provisional resume id
    // if it diverged; terminal is authoritative).
    db.query(`UPDATE sessions SET cc_session_id = ? WHERE id = ?`).run(
      params.ccSessionId,
      params.projectedSessionId,
    );
    return params.projectedSessionId;
  }

  // Orphan reconciliation. The orphan session carries the hook events (FK
  // `events.session_id → sessions.id`). ADOPT it onto the projected assignment
  // by re-pointing its assignment_id, then drop the empty projected placeholder
  // and the orphan's now-empty assignment. This is O(1) row moves — the hook
  // events follow the session, no per-event rewrite.
  //
  // Order matters against the partial unique index `idx_sessions_active_assignment`
  // (≤ 1 OPEN session per assignment): the projected placeholder must be removed
  // BEFORE the orphan is re-pointed onto the projected assignment, or two open
  // sessions would momentarily share it. The placeholder has no events of its
  // own (started created it empty), so deleting it loses nothing.

  // 1. Delete the empty projected placeholder session.
  db.query(`DELETE FROM sessions WHERE id = ?`).run(params.projectedSessionId);

  // 2. Re-point the orphan session onto the projected assignment and stamp the
  //    authoritative cc_session_id (idempotent — it already equals ccSessionId,
  //    but the SET keeps the write explicit and survives a provisional mismatch).
  //    INTENTIONAL INVARIANT: the adopted session stays OPEN (`ended_at` NULL)
  //    after the terminal transition — sessions are closed by the ingestor's
  //    convention (hook Stop), not by lifecycle projection, so late-arriving
  //    hook events still ingest. The open row keeps occupying the
  //    `idx_sessions_active_cc_session_id` partial index by design: it IS the
  //    one active row for that cc_session_id.
  db.query(
    `UPDATE sessions SET assignment_id = ?, cc_session_id = ? WHERE id = ?`,
  ).run(params.projectedAssignmentId, params.ccSessionId, orphan.sessionId);

  // 3. Delete the orphan's now-empty assignment (its session moved away; the
  //    shared orphan task + per-orphan agent are bookkeeping, left in place).
  db.query(`DELETE FROM agent_task_assignment WHERE id = ?`).run(
    orphan.assignmentId,
  );

  return orphan.sessionId;
}

/**
 * Find an S5 orphan session holding `ccSessionId` that is NOT already the
 * projection's own session. Returns the orphan's session + assignment, or null
 * when there's nothing to reconcile (no orphan, or the projected session already
 * carries the id from a provisional stamp).
 */
function findReconcilableOrphan(
  db: Database,
  params: BackfillParams,
): { sessionId: string; assignmentId: string } | null {
  const row = db
    .query(
      `SELECT id, assignment_id
       FROM sessions
       WHERE cc_session_id = ? AND id != ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    )
    .get(params.ccSessionId, params.projectedSessionId) as
    | { id: string; assignment_id: string }
    | null;
  if (!row) return null;
  return { sessionId: row.id, assignmentId: row.assignment_id };
}

// ---------------------------------------------------------------------------
// State-machine driving
// ---------------------------------------------------------------------------

/**
 * Apply one transition, tolerating an idempotent no-op (a redelivered envelope
 * trying to re-apply an already-applied move). Logs other failures to stderr —
 * the projection must not throw out of the renderer's render() path.
 */
function driveTo(
  db: Database,
  assignmentId: string,
  sessionId: string,
  action: "start",
): void {
  // Idempotency: a redelivered `started` finds the assignment already advanced
  // past `dispatched`. The state machine only allows `start` FROM `dispatched`,
  // so re-applying it from any later state is a benign no-op — NOT an error
  // worth a log line. Guard on the current state so redelivery stays silent and
  // only a genuinely-unexpected failure (assignment vanished mid-txn) surfaces.
  const current = currentAssignmentState(db, assignmentId);
  if (current !== "dispatched") return;

  const result = applyTransition(db, assignmentId, sessionId, { type: action });
  if (!result.ok) {
    process.stderr.write(
      `[mission-control] dispatch-projection: '${action}' on assignment '${assignmentId}' failed unexpectedly (${result.error})\n`,
    );
  }
}

/**
 * Walk an assignment to a terminal state. A terminal envelope may arrive while
 * the assignment is still `dispatched` (started lost/reordered), or already
 * `running`. The state machine only allows complete/fail/cancel FROM `running`
 * (cancel also from queued/dispatched/blocked), so:
 *
 *   - `cancel` (aborted): legal from dispatched OR running → one step.
 *   - `complete`/`fail`: require `running` → if still `dispatched`, drive
 *     `start` first, then the terminal action.
 *
 * Idempotent: re-running on an already-terminal assignment is a tolerated
 * no-op (the state machine rejects outgoing transitions from terminal states).
 */
function driveToTerminal(
  db: Database,
  assignmentId: string,
  sessionId: string,
  action: "complete" | "fail" | "cancel",
): void {
  const current = currentAssignmentState(db, assignmentId);
  if (current === null) return;

  // Already terminal → idempotent no-op.
  if (
    current === "completed" ||
    current === "failed" ||
    current === "cancelled"
  ) {
    return;
  }

  // complete/fail need `running`; bridge from `dispatched` via `start`.
  if (
    (action === "complete" || action === "fail") &&
    current === "dispatched"
  ) {
    const started = applyTransition(db, assignmentId, sessionId, {
      type: "start",
    });
    if (!started.ok) {
      process.stderr.write(
        `[mission-control] dispatch-projection: bridge 'start' before '${action}' failed for assignment '${assignmentId}': ${started.error}\n`,
      );
      return;
    }
  }

  const result = applyTransition(db, assignmentId, sessionId, { type: action });
  if (!result.ok) {
    process.stderr.write(
      `[mission-control] dispatch-projection: terminal '${action}' failed for assignment '${assignmentId}': ${result.error}\n`,
    );
  }
}

function currentAssignmentState(
  db: Database,
  assignmentId: string,
): AssignmentState | null {
  const row = db
    .query(`SELECT state FROM agent_task_assignment WHERE id = ?`)
    .get(assignmentId) as { state: AssignmentState } | null;
  return row ? row.state : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map `envelope.type` to its lifecycle kind, or null when the type is not a
 * recognised `dispatch.task.{started|completed|failed|aborted}`. This is the
 * authoritative type filter — the renderer subscribes broadly (subject
 * wildcards) and everything non-matching is dropped here.
 */
function lifecycleKind(type: string): LifecycleKind | null {
  switch (type) {
    case "dispatch.task.started":
      return "started";
    case "dispatch.task.completed":
      return "completed";
    case "dispatch.task.failed":
      return "failed";
    case "dispatch.task.aborted":
      return "aborted";
    default:
      return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
