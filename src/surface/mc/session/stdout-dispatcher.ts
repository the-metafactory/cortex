/**
 * Grove Mission Control v2 — Controlled-session stdout dispatcher (F-13).
 *
 * Reads CC's stream-json stdout line-by-line, inserts each event into the
 * DB, broadcasts via WebSocket, and drives the state machine on the
 * terminal `result` event.
 *
 * Rationale (from design-mission-control.md §6.1 Transport):
 *   claude stdout (stream-json) ──▶ event parser ──▶ WebSocket ──▶ dashboard
 *
 * notifications.ts names this the "Phase B dispatcher after applyTransition"
 * component. It is the read-side complement to the session endpoint's
 * write-side (stdin framing in stream-json.ts).
 */

import type { Database } from "bun:sqlite";
import type { Action } from "../types";
import type { WsClientRegistry } from "../ws/client-registry";
import { insertEvent } from "../db/events";
import { applyTransition } from "../db/transitions";
import {
  broadcastEvent,
  broadcastTransition,
  maybeNotifyDiscord,
  type MaybeNotifyDeps,
  type NotificationContext,
} from "../notifications";

export interface StdoutDispatcherDeps {
  db: Database;
  wsRegistry: WsClientRegistry;
  sessionId: string;
  assignmentId: string;
  /**
   * F-11 Discord notification deps. Optional — when absent or
   * `notify.config.enabled === false`, the terminal transition only fires
   * `broadcastTransition` and `broadcastEvent` exactly as before.
   * See `docs/design-mc-f11-discord-notifications.md`.
   */
  notify?: MaybeNotifyDeps;
}

export interface StdoutDispatcherHandle {
  /**
   * Promise that resolves when the stream has ended and all buffered lines
   * have been dispatched. Await this in tests to avoid races; in production
   * it resolves when CC's stdout closes (process exit).
   */
  done: Promise<void>;
}

/**
 * Attach a dispatcher to a ReadableStream of CC stream-json stdout.
 *
 * Lifetime: the returned handle's `done` resolves when the stream ends.
 * No explicit stop is exposed — CC owns stream lifetime via process exit,
 * and closing the stream early would discard events we want to persist.
 *
 * Malformed lines are logged to stderr and skipped. Per CLAUDE.md's "no
 * empty catch" rule, every non-dispatched line is visible to operators.
 */
export function startStdoutDispatcher(
  stdout: ReadableStream<Uint8Array>,
  deps: StdoutDispatcherDeps
): StdoutDispatcherHandle {
  const done = consumeStream(stdout, deps).catch((err: unknown) => {
    // Reading CC's stdout should never throw in normal operation, but if the
    // stream errors (e.g. process killed mid-read) we surface it rather than
    // drop it — a silent swallow here would hide dispatcher crashes.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[stdout-dispatcher] stream read failed for ${deps.sessionId}: ${message}\n`
    );
  });
  return { done };
}

async function consumeStream(
  stdout: ReadableStream<Uint8Array>,
  deps: StdoutDispatcherDeps
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  const reader = stdout.getReader();
  let buffer = "";

  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // `stream: true` flushes only complete code points, keeping multi-byte
      // chars that straddle chunk boundaries intact.
      buffer += decoder.decode(value, { stream: true });

      // Dispatch every complete line; leave the trailing partial in buffer.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        dispatchLine(line, deps);
      }
    }

    // Flush the final line if CC exited without a trailing newline.
    const tail = buffer + decoder.decode();
    if (tail.length > 0) dispatchLine(tail, deps);
  } finally {
    reader.releaseLock();
  }
}

function dispatchLine(line: string, deps: StdoutDispatcherDeps): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_err) {
    process.stderr.write(
      `[stdout-dispatcher] skipping malformed line for ${deps.sessionId} (first 200 chars: ${trimmed.slice(0, 200)})\n`
    );
    return;
  }

  if (typeof parsed !== "object" || parsed === null) {
    process.stderr.write(
      `[stdout-dispatcher] skipping non-object line for ${deps.sessionId} (first 200 chars: ${trimmed.slice(0, 200)})\n`
    );
    return;
  }

  const payload = parsed as Record<string, unknown>;
  const rawType = payload.type;
  const eventType =
    typeof rawType === "string" && rawType.length > 0
      ? `stream-json.${rawType}`
      : "stream-json.unknown";

  const event = insertEvent(deps.db, {
    sessionId: deps.sessionId,
    type: eventType,
    payload,
  });
  broadcastEvent(deps.wsRegistry, deps.sessionId, event);

  // Terminal event: CC emits `{ type: "result", subtype: "success" | "error_..." }`
  // at the end of a turn. We drive the state machine running → completed/failed
  // so the dashboard can release the operator input queue on a real end-of-turn
  // signal rather than inferring from every event (see dashboard F-A4 TODO).
  if (rawType === "result") {
    applyTerminalTransition(payload, deps);
  }
}

function applyTerminalTransition(
  payload: Record<string, unknown>,
  deps: StdoutDispatcherDeps
): void {
  const subtype = typeof payload.subtype === "string" ? payload.subtype : "";
  const isSuccess = subtype === "success";
  const action: Action = isSuccess
    ? { type: "complete" }
    : {
        type: "fail",
        error:
          typeof payload.result === "string"
            ? payload.result
            : subtype || "unknown",
      };

  const result = applyTransition(
    deps.db,
    deps.assignmentId,
    deps.sessionId,
    action
  );

  if (!result.ok) {
    // Invalid transition (e.g. already blocked by a permission request).
    // Log and continue — the event itself was persisted, the dashboard can
    // still reflect current state from the next transition.
    process.stderr.write(
      `[stdout-dispatcher] terminal transition(${action.type}) failed for ${deps.assignmentId}: ${result.error}\n`
    );
    return;
  }

  broadcastTransition(
    deps.wsRegistry,
    deps.assignmentId,
    result.from,
    result.assignment.state,
    result.assignment.block_reason
  );

  // F-11: Discord notifications. Terminal transitions (`completed`/`failed`)
  // are notification-worthy per Decision 1 — failures land in the repo
  // thread for post-mortem context, P0 completions get a low-weight
  // channel post. Non-terminal transitions never reach this branch
  // (`applyTerminalTransition` only fires on `result` events). When
  // `deps.notify` is absent the call is skipped entirely.
  if (deps.notify) {
    const ctx = loadNotificationContext(deps.db, deps.assignmentId);
    if (ctx) {
      void maybeNotifyDiscord(deps.notify, {
        from: result.from,
        to: result.assignment.state,
        blockReason: result.assignment.block_reason,
        ctx,
      });
    }
  }
}

/**
 * F-11: Build a `NotificationContext` for a terminal transition. Reads
 * the assignment's joined task row in one query — the data was already
 * cached by the broadcast above, but reading it again here keeps this
 * function self-contained and avoids growing the dispatcher's tight
 * `Deps` shape with task fields.
 *
 * Returns `null` if the assignment row vanishes between transition and
 * notification (extremely unlikely; defensive).
 */
function loadNotificationContext(
  db: Database,
  assignmentId: string
): NotificationContext | null {
  const row = db
    .query(
      `SELECT
         t.id           AS task_id,
         t.title        AS task_title,
         t.priority     AS task_priority,
         t.operator_id  AS operator_id,
         t.source_url   AS source_url,
         t.source_external_id AS source_external_id,
         a.name         AS agent_name
       FROM agent_task_assignment ata
       JOIN tasks t   ON t.id = ata.task_id
       JOIN agents a  ON a.id = ata.agent_id
       WHERE ata.id = ?`
    )
    .get(assignmentId) as
    | {
        task_id: string;
        task_title: string;
        task_priority: number;
        operator_id: string;
        source_url: string | null;
        source_external_id: string | null;
        agent_name: string;
      }
    | null;

  if (!row) return null;

  const taskRef = row.source_external_id
    ? `T-${row.source_external_id}`
    : `T-${row.task_id.slice(0, 6)}`;

  return {
    assignmentId,
    agentName: row.agent_name,
    taskId: row.task_id,
    taskRef,
    taskTitle: row.task_title,
    priority: row.task_priority,
    taskSourceUrl: row.source_url,
    operatorId: row.operator_id,
    observedAtMs: Date.now(),
  };
}
