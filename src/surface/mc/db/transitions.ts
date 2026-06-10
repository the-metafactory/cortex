/**
 * Grove Mission Control v2 — Transition applier.
 *
 * Glue between the pure state machine and the database.
 * Reads current state, transitions, updates assignment, inserts event — all in one transaction.
 */

import type { Database } from "bun:sqlite";
import type { Action, AssignmentState, BlockReason, McEvent } from "../types";
import { transition } from "../state-machine";
import { insertEvent } from "./events";

/**
 * Terminal assignment states (see state-machine.ts: `completed`/`cancelled`
 * have no outgoing transitions; `failed` only allows `principal_requeue` back
 * to `queued`). When a transition lands one of these, the assignment's turn is
 * over — so we stamp the open session's `ended_at` in the SAME transaction.
 *
 * This is the #857 fix: before this, orphan (and any observed) sessions
 * auto-completed via the ingestor but their `sessions.ended_at` was NEVER set,
 * so "terminal age" was uncomputable and the retention prune had no anchor.
 * Stamping here (rather than in the ingestor) keeps "assignment terminal" and
 * "session ended" consistent across EVERY transition path, not just the
 * ingestor's auto-complete.
 */
const TERMINAL_STATES: ReadonlySet<AssignmentState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

interface AssignmentRow {
  id: string;
  agent_id: string;
  task_id: string;
  state: AssignmentState;
  block_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ApplySuccess {
  ok: true;
  /** The state the assignment transitioned *from* (the pre-transition state). */
  from: AssignmentState;
  assignment: {
    id: string;
    state: AssignmentState;
    block_reason: BlockReason | null;
  };
  event: McEvent;
}

interface ApplyError {
  ok: false;
  error: string;
}

export type ApplyResult = ApplySuccess | ApplyError;

export function applyTransition(
  db: Database,
  assignmentId: string,
  sessionId: string,
  action: Action
): ApplyResult {
  // Read current state
  const row = db
    .query("SELECT * FROM agent_task_assignment WHERE id = ?")
    .get(assignmentId) as AssignmentRow | null;

  if (!row) {
    return { ok: false, error: `Assignment '${assignmentId}' not found` };
  }

  const currentState = row.state;

  // Call pure state machine
  const result = transition(currentState, action);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Build event payload
  const eventPayload: Record<string, unknown> = {
    from: currentState,
    to: result.state,
    action: action.type,
  };

  if (action.type === "block") {
    eventPayload.blockReason = action.reason;
  }

  if (action.type === "fail" && "error" in action && action.error) {
    eventPayload.failError = action.error;
  }

  // Execute DB updates in a transaction
  const blockReasonJson = result.blockReason
    ? JSON.stringify(result.blockReason)
    : null;
  const now = new Date().toISOString();

  // Concurrency guard: include the current state in the WHERE so two
  // racing applyTransition calls cannot both succeed against the same
  // assignment. If `changes !== 1`, another writer transitioned between
  // our read and our write — abort the transaction (throw forces rollback).
  const txn = db.transaction(() => {
    const update = db
      .query(
        `UPDATE agent_task_assignment
         SET state = ?, block_reason = ?, updated_at = ?
         WHERE id = ? AND state = ?`
      )
      .run(result.state, blockReasonJson, now, assignmentId, currentState);

    if (update.changes !== 1) {
      throw new Error(
        `Concurrent transition: assignment '${assignmentId}' state changed during apply`
      );
    }

    // #857 — stamp ended_at on the assignment's open session when the
    // transition lands a terminal state. Guarded on `ended_at IS NULL` so a
    // session that was already ended (defense-in-depth; terminal states have
    // no re-entry path through the state machine anyway) is never re-stamped
    // with a later timestamp. Scoped to the assignment's currently-open
    // session via the same partial-unique invariant the schema enforces
    // (`idx_sessions_active_assignment`: at most one open session per
    // assignment), so this touches exactly the row that just went terminal.
    if (TERMINAL_STATES.has(result.state)) {
      db.query(
        `UPDATE sessions SET ended_at = ?
         WHERE assignment_id = ? AND ended_at IS NULL`
      ).run(now, assignmentId);
    }

    return insertEvent(db, {
      sessionId,
      type: "state.transition",
      payload: eventPayload,
    });
  });

  let event: McEvent;
  try {
    event = txn();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  return {
    ok: true,
    from: currentState,
    assignment: {
      id: assignmentId,
      state: result.state,
      block_reason: result.blockReason,
    },
    event,
  };
}
