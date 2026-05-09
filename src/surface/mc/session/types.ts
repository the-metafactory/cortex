/**
 * Grove Mission Control v2 — Session endpoint types.
 *
 * The session endpoint is the abstraction boundary between orchestration
 * and the actual CC process. Callers use write/close without knowing
 * whether the session is a local child process or a hook-observed external.
 */

import type { Subprocess } from "bun";
import type { EndpointKind } from "../types";
import type { StreamJsonContentBlock } from "./stream-json";

export interface SessionEndpoint {
  kind: EndpointKind;
  sessionId: string;
  /**
   * Write an operator message to the session.
   *
   * - String input — legacy text-only path; sent verbatim as
   *   `content: "..."` (F-10 drill-down input).
   * - Content-block array — rich-content path for image + text mixes
   *   (image-input feature; `docs/design-mc-image-input.md` Decision 2).
   */
  write(message: string | StreamJsonContentBlock[]): void;
  close(): Promise<void>;
}

export interface ManagedProcess {
  proc: Subprocess;
  sessionId: string;
  assignmentId: string;
  spawnedAt: number;
  /**
   * True while an explicit close()/closeAll() is in flight.
   * Why: the `proc.exited` auto-handler and close()/closeAll() both race to run
   * DB cleanup (endSession). `closing` is the authoritative guard — the exit
   * handler skips cleanup when it sees `closing=true`, because the initiator
   * will do it. Using `ProcessManager.has()` as the guard (the previous
   * approach) races: the map can be cleared before the exit handler fires,
   * causing endSession to be skipped entirely and leaving open sessions in DB.
   */
  closing: boolean;
  /**
   * Hook invoked once by closeAll after the process exits. endpoint-resolver
   * sets this to `endSession(db, sessionId)` so bulk shutdown can finalize
   * DB state without ProcessManager depending on the DB layer.
   */
  onCleanup?: () => void | Promise<void>;
  /**
   * F-13: resolves when the stdout dispatcher has drained the CC stream.
   * Undefined when the endpoint-resolver was invoked without a dispatcher.
   * Tests await this to synchronize on event ingestion without racing the
   * producer.
   */
  dispatcherDone?: Promise<void>;
}

export class NotControllable extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Session '${sessionId}' is observed (not controlled) — write is not supported`
    );
    this.name = "NotControllable";
    this.sessionId = sessionId;
  }
}

/**
 * Thrown when a caller tries to spawn a controlled session for an assignment
 * that already has an active session row in the DB with no live managed
 * process. Caller must explicitly resolve the stale row (close the existing
 * endpoint) before retrying — spawning blind would leave orphans.
 */
export class SessionConflict extends Error {
  readonly assignmentId: string;
  readonly existingSessionId: string;

  constructor(assignmentId: string, existingSessionId: string) {
    super(
      `Assignment '${assignmentId}' has an active session '${existingSessionId}' with no live managed process — resolve before re-spawning`
    );
    this.name = "SessionConflict";
    this.assignmentId = assignmentId;
    this.existingSessionId = existingSessionId;
  }
}

/**
 * Thrown by controlled endpoint write() when the target process has already
 * exited or is mid-close. Callers must fail fast rather than buffer into
 * stdin of a dead process.
 */
export class SessionClosed extends Error {
  readonly sessionId: string;
  readonly exitCode: number | null;

  constructor(sessionId: string, exitCode: number | null) {
    super(
      exitCode === null
        ? `Session '${sessionId}' is closing — write rejected`
        : `Session '${sessionId}' process has exited (code=${exitCode}) — write rejected`
    );
    this.name = "SessionClosed";
    this.sessionId = sessionId;
    this.exitCode = exitCode;
  }
}
