/**
 * Grove Mission Control v2 — Notification bridge.
 *
 * Wires DB mutations (applyTransition, insertEvent) to two outbound
 * surfaces: the WebSocket broadcast for the dashboard (always on) and the
 * F-11 Discord push sink (opt-in via `grove.notifications.discord`).
 *
 * Both surfaces are best-effort relative to the state machine: the DB
 * layer (`db/transitions.ts`, `db/events.ts`) stays pure — no import of
 * `ws/types`, `client-registry`, or the Discord sink. All fan-out happens
 * at the call site (`api/handlers.ts`, `session/stdout-dispatcher.ts`).
 *
 * Background:
 *   - F-5 review blocker #2: "wsRegistry destructured but never used —
 *     the WS server currently emits nothing in production." This file
 *     fills that gap with `broadcastTransition` / `broadcastEvent`.
 *   - F-11 (`docs/design-mc-f11-discord-notifications.md`) re-exports the
 *     `maybeNotifyDiscord` family so call sites have a single import path
 *     for "broadcast the transition AND maybe push it to Discord".
 *
 * The bridge functions are called by:
 *   - HookStreamPoller after ingesting events (for observed sessions)
 *   - Phase B dispatcher after applyTransition (for controlled sessions)
 */

import type { WsClientRegistry } from "./ws/client-registry";
import type { AssignmentState, BlockReason, McEvent } from "./types";
import type { ProcessManager } from "./session/process-manager";
import type {
  IterationDetail,
  IterationListItem,
  IterationState,
} from "./db/iterations";
import type { TaskListItem } from "./db/tasks";

// F-11 re-exports — see notifications/discord-sink.ts for the full
// hot-path implementation, and notifications/should-notify.ts for the
// pure policy that the sink consumes.
export {
  maybeNotifyDiscord,
  type MaybeNotifyDeps,
  type NotificationContext,
  type DiscordNotifier,
  type DiscordSinkConfig,
  type FlushScheduler,
} from "./notifications/discord-sink";

/**
 * Broadcast a state transition to all connected dashboard clients.
 * Called after a successful applyTransition.
 */
export function broadcastTransition(
  wsRegistry: WsClientRegistry,
  assignmentId: string,
  from: AssignmentState,
  to: AssignmentState,
  blockReason?: BlockReason | null
): void {
  wsRegistry.broadcast({
    type: "state.transition",
    assignmentId,
    from,
    to,
    blockReason,
  });
}

/**
 * Broadcast a new event to all connected dashboard clients.
 * Called after insertEvent or batch ingest.
 */
export function broadcastEvent(
  wsRegistry: WsClientRegistry,
  sessionId: string,
  event: McEvent
): void {
  wsRegistry.broadcast({
    type: "event",
    sessionId,
    event,
  });
}

/**
 * F-15 — broadcast an `iteration.created` event after a successful
 * `POST /api/iterations`. Mirrors `broadcastTransition` exactly: the
 * write has already committed in the DB; this only fans the new row
 * out to live dashboard clients. The hook layer applies the row
 * optimistically (no debounced refetch) per the F-15 design.
 */
export function broadcastIterationCreated(
  wsRegistry: WsClientRegistry,
  iteration: IterationDetail
): void {
  wsRegistry.broadcast({ type: "iteration.created", iteration });
}

/**
 * F-15 — broadcast an `iteration.updated` event after any successful
 * `PATCH /api/iterations/:id`, attach, or detach.
 *
 * Per Echo grove-v2#42 (Major 3) — this carries the header-only
 * `IterationListItem` shape (NOT the full `IterationDetail`). The
 * kanban subscribes to this broad event for in-place row patches and
 * doesn't need body / imported_body / tasks; shipping those to every
 * connected tab on every body autosave (debounced ~1s during a
 * writing session) wasted bandwidth and made the kanban consumer's
 * `iterations[]` shape inconsistent across the session (a row would
 * silently carry the body until the next refetch swapped it back).
 *
 * Detail subscribers get the full row via
 * `broadcastIterationDetailUpdated` paired from the same handler call.
 */
export function broadcastIterationUpdated(
  wsRegistry: WsClientRegistry,
  iteration: IterationListItem
): void {
  wsRegistry.broadcast({ type: "iteration.updated", iteration });
}

/**
 * F-15 sweep — broadcast a per-id `iteration.detail_updated` event
 * carrying the full `IterationDetail`. Paired with
 * `broadcastIterationUpdated` from every PATCH / attach / detach
 * handler, so the detail surface's narrow per-id subscription gets
 * the body / tasks delta while the kanban's broad subscription only
 * pays for the header row.
 *
 * Per Echo grove-v2#42 (Major 3) — the broadcast surface split is the
 * goal; the detail event is the narrower side that carries the
 * detail-only fields.
 */
export function broadcastIterationDetailUpdated(
  wsRegistry: WsClientRegistry,
  iteration: IterationDetail
): void {
  wsRegistry.broadcast({ type: "iteration.detail_updated", iteration });
}

/**
 * F-15 — broadcast an `iteration.state_changed` event whenever a
 * PATCH actually moves the `state` column. Sent IN ADDITION to
 * `iteration.updated` (NOT instead of) so subscribers that only care
 * about column-membership transitions can subscribe narrowly without
 * eating every body-edit frame.
 *
 * The split mirrors `assignment.state.transition` vs `event` on the
 * execution side: one is a row mutation, the other is a column move.
 */
export function broadcastIterationStateChanged(
  wsRegistry: WsClientRegistry,
  iterationId: string,
  from: IterationState,
  to: IterationState
): void {
  wsRegistry.broadcast({
    type: "iteration.state_changed",
    iterationId,
    from,
    to,
  });
}

/**
 * F-16 sweep — broadcast a `task.updated` event when a task row mutates
 * in a way the cross-surface row-cached subscribers (focus area, task
 * table) can't infer from `iteration.updated` alone.
 *
 * Per Echo grove-v2#43 (Major 1) — `iteration.updated` patches in place
 * via `row.iteration?.id === it.id`, which never matches when a task
 * flips `iteration_id` (null → attached, attached → null, or moved
 * between iterations). The patch handler bails on the id mismatch, the
 * cached row stays stale, and the chip / column don't update until the
 * next unrelated `state.transition` triggers a refetch.
 *
 * Backend re-reads the task with the JOIN-derived denorm and emits the
 * fresh `TaskListItem` here. Subscribers replace the row in place.
 *
 * Called from attach/detach paths (and the create-and-attach branch);
 * not called for state.transition (the existing
 * `broadcastTransition` + state.transition-triggered refetch already
 * handles task state changes).
 */
export function broadcastTaskUpdated(
  wsRegistry: WsClientRegistry,
  task: TaskListItem
): void {
  wsRegistry.broadcast({ type: "task.updated", task });
}

/**
 * F-12 Decision 11 — process-kill observer.
 *
 * Decisions 5/6/7 all assume a side effect that the existing process-manager
 * plumbing does NOT provide on its own: closing the live CC subprocess when
 * an assignment moves into `cancelled` (Abandon, in-flight Hand-off) or out
 * of `blocked` via `operator_requeue` (Requeue from blocked).
 *
 * Without this hook, the F-12 verbs misbehave:
 *   - Abandon on `running` flips state to `cancelled` while the CC subprocess
 *     keeps running and emitting events.
 *   - In-flight Hand-off leaves two concurrent CC processes racing.
 *   - Requeue from `blocked` strands a live blocked process; the next
 *     dispatch hits the idempotency path and reuses the stale session.
 *
 * Behaviour:
 *   - Looks up `processManager.get(sessionId)`.
 *   - If a managed process exists and is alive, calls `endpoint.close()`
 *     via the close path the caller passes in (dependency injection so
 *     this module stays free of session/endpoint-resolver imports — see
 *     `notifications.ts`'s preamble note about keeping DB layer pure).
 *   - If no managed process or already exited, no-op.
 *
 * Atomicity: the kill is necessarily out-of-transaction. The DB transition
 * has already committed by the time this fires. If the kill itself fails
 * the underlying close() path logs to stderr; this function does not throw.
 *
 * The observer is intentionally generic over "close this session" — the
 * caller passes a `closeSession(sessionId)` thunk so we don't pull in
 * `endpoint-resolver` (and its transitive `db/sessions` writes) here.
 * `api/handlers.ts` wires the thunk to `createControlledEndpoint(...).close()`.
 */
export interface ObserveCancelDeps {
  processManager: ProcessManager;
  /**
   * Close-session thunk. Called with the session id; expected to fire SIGTERM
   * and finalize DB cleanup. Errors are swallowed (best-effort enforcement).
   */
  closeSession: (sessionId: string) => Promise<void>;
}

/**
 * Decide whether a state transition should trigger a process-kill side
 * effect. Pure function so tests can pin the policy table.
 */
export function shouldCloseSessionOnTransition(
  from: AssignmentState,
  to: AssignmentState,
  action: string
): boolean {
  // Any transition into `cancelled` (Abandon, in-flight Hand-off step 1).
  if (to === "cancelled") return true;
  // operator_requeue from `blocked` — the only requeue path with a live
  // managed process. `failed → queued` requeue has no live session by
  // definition (failed is reached via stdout-dispatcher's `proc.exited`
  // cleanup, which has already endSession'd).
  if (action === "operator_requeue" && from === "blocked") return true;
  return false;
}

/**
 * Fire-and-forget: kick off `closeSession(sessionId)` if the transition
 * matches the policy AND a live managed process is currently tracked.
 *
 * Intentionally synchronous to the caller — the close itself runs async
 * in the background. Returns the in-flight promise (or null) so tests can
 * `await` the kill before asserting on session state.
 */
export function observeTransitionForCancel(
  deps: ObserveCancelDeps,
  sessionId: string,
  from: AssignmentState,
  to: AssignmentState,
  action: string
): Promise<void> | null {
  if (!shouldCloseSessionOnTransition(from, to, action)) return null;

  const managed = deps.processManager.get(sessionId);
  // No managed process tracked (already exited / observed session / never
  // controlled) → nothing to kill. The DB cleanup path that ran on the
  // child's natural exit already covered it.
  if (!managed) return null;
  // Already exiting / closing — don't double-call close().
  if (managed.closing) return null;
  if (managed.proc.exitCode !== null) return null;

  return deps.closeSession(sessionId).catch((err) => {
    // Best-effort enforcement: the DB state is the source of truth, the
    // kill is enforcement on top. Log and swallow.
    process.stderr.write(
      `[notifications] observeTransitionForCancel: closeSession(${sessionId}) failed: ${(err as Error).message}\n`
    );
  });
}
