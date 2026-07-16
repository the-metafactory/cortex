/**
 * Grove Mission Control v2 — Session endpoint resolver.
 *
 * Given an assignment_id, returns a SessionEndpoint handle { kind, write, close }.
 * The abstraction boundary between orchestration and CC processes.
 */

import type { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { configHomeSpawnEnv } from "../../../common/substrates/config-home";
import type { SessionEndpoint, ManagedProcess } from "./types";
import type { StreamJsonContentBlock } from "./stream-json";
import { NotControllable, SessionConflict, SessionClosed } from "./types";
import { ProcessManager } from "./process-manager";
import { findActiveSession, endSession, createSession } from "../db/sessions";
import { buildStreamJsonMessage } from "./stream-json";
import {
  startStdoutDispatcher,
  type StdoutDispatcherHandle,
} from "./stdout-dispatcher";
import type { WsClientRegistry } from "../ws/client-registry";

/**
 * Resolve an existing active session to an endpoint handle.
 * Returns null if no active session exists for the assignment.
 */
export function resolveSessionEndpoint(
  db: Database,
  processManager: ProcessManager,
  assignmentId: string
): SessionEndpoint | null {
  const session = findActiveSession(db, assignmentId);
  if (!session) return null;

  if (session.endpoint_kind === "local.process.controlled") {
    return createControlledEndpoint(db, processManager, session.id);
  }

  if (session.endpoint_kind === "local.observed") {
    return createObservedEndpoint(session.id);
  }

  // local.process.autonomous — not implemented in F-3
  return null;
}

/**
 * Spawn type — injectable for testing.
 */
export type SpawnFn = (args: string[]) => Subprocess;

const defaultSpawn: SpawnFn = (args) => {
  // One of the two places cortex spawns `claude` (the other is
  // runner/cc-session.ts). Both must export the deployment's configured config
  // home, or the child authenticates against the vendor-default credential,
  // which refreshes independently of the principal's and expires. `env` is
  // omitted when nothing is declared → plain inherit (the pre-existing
  // behaviour). The decision itself lives in — and is unit-tested at —
  // common/substrates/config-home.ts, because THIS wrapper is an injection-seam
  // default that every test replaces, so logic placed here would never run
  // under CI.
  const env = configHomeSpawnEnv("claude-code");
  return Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(env && { env }),
  });
};

/**
 * Spawn a new controlled CC session for an assignment.
 *
 * Idempotency: if an active controlled session already exists for the
 * assignment AND its managed process is still alive, the existing endpoint
 * is returned instead of spawning a duplicate. This prevents orphan processes
 * under concurrent callers. The schema-level unique index on
 * sessions(assignment_id) WHERE ended_at IS NULL acts as a defense-in-depth
 * guard if two callers race past the check below.
 *
 * Throws `SessionConflict` if the DB has an active session for this
 * assignment but its managed process is NOT alive — this is a stuck-state
 * that the caller must resolve (by calling close() on the stale endpoint
 * first) rather than by silently spawning another process.
 */
export interface SpawnControlledOptions {
  extraArgs?: string[];
  spawn?: SpawnFn;
  /**
   * If provided, attach an F-13 stdout dispatcher to the spawned process.
   * Each stream-json line becomes an event row + WS broadcast; the terminal
   * `result` event drives applyTransition(running → completed|failed).
   *
   * Omit in tests that don't exercise event ingestion. Omitting keeps the
   * F-3 behavior — stdin-only — for back-compat.
   */
  dispatcher?: {
    wsRegistry: WsClientRegistry;
  };
}

export function spawnControlledSession(
  db: Database,
  processManager: ProcessManager,
  assignmentId: string,
  options?: SpawnControlledOptions
): SessionEndpoint {
  const existing = findActiveSession(db, assignmentId);
  if (existing) {
    const existingManaged = processManager.get(existing.id);
    if (
      existingManaged?.proc.exitCode === null &&
      !existingManaged.closing
    ) {
      // Healthy active session — return its endpoint. Idempotent spawn.
      return createControlledEndpoint(db, processManager, existing.id);
    }
    // DB says active, but no live managed process tracks it — refuse to spawn
    // a second. Caller must resolve the stale row before retrying.
    throw new SessionConflict(assignmentId, existing.id);
  }

  const spawn = options?.spawn ?? defaultSpawn;

  const args = [
    "claude",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    ...(options?.extraArgs ?? []),
  ];

  const proc = spawn(args);

  const session = createSession(db, {
    assignmentId,
    endpointKind: "local.process.controlled",
    pid: proc.pid,
  });

  const managed: ManagedProcess = {
    proc,
    sessionId: session.id,
    assignmentId,
    spawnedAt: Date.now(),
    closing: false,
    onCleanup: () => {
      endSession(db, session.id);
    },
  };

  processManager.add(managed);

  // F-13: attach stdout dispatcher if the caller wired one up. Kept optional
  // so unit tests that only exercise the write side (F-3 behavior) don't need
  // to construct a WsClientRegistry.
  let dispatcherHandle: StdoutDispatcherHandle | undefined;
  if (options?.dispatcher && proc.stdout) {
    dispatcherHandle = startStdoutDispatcher(
      proc.stdout as ReadableStream<Uint8Array>,
      {
        db,
        wsRegistry: options.dispatcher.wsRegistry,
        sessionId: session.id,
        assignmentId,
      }
    );
  }
  // Hold the handle off the loose-end linter — tests can still await
  // `managed.dispatcherDone` via the exposed ManagedProcess extension.
  if (dispatcherHandle) {
    managed.dispatcherDone = dispatcherHandle.done;
  }

  // Auto-exit handler: fires when the child exits on its own (external kill,
  // crash, natural termination). Gated by `closing` so close()/closeAll()
  // own DB cleanup when they initiate shutdown, avoiding double-endSession
  // calls and the map-clear-before-exit race flagged in F-3 review.
  proc.exited
    .then(async () => {
      if (managed.closing) return;
      // Wait for the dispatcher to drain before finalizing: the terminal
      // `result` event and its state.transition broadcast must land before
      // endSession sets ended_at, otherwise the dashboard sees a closed
      // session with no final transition and the principal queue stays stuck.
      if (managed.dispatcherDone) await managed.dispatcherDone;
      processManager.remove(session.id);
      endSession(db, session.id);
    })
    .catch((err: unknown) => {
      // endSession / processManager.remove should never throw, but if they do
      // (e.g. DB closed mid-shutdown) we must not leave an unhandled rejection.
      process.stderr.write(
        `[endpoint] auto-exit cleanup failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    });

  return createControlledEndpoint(db, processManager, session.id);
}

/**
 * Grace period a child gets to exit cleanly after SIGTERM in close() before
 * we escalate to SIGKILL. Mirrors ProcessManager.closeAll's 5s budget.
 */
const CLOSE_GRACEFUL_TIMEOUT_MS = 5000;

export function createControlledEndpoint(
  db: Database,
  processManager: ProcessManager,
  sessionId: string
): SessionEndpoint {
  return {
    kind: "local.process.controlled",
    sessionId,

    // Explicit annotation matches SessionEndpoint.write; TS method-parameter
    // bivariance would accept the narrower `(message: string)`, but the
    // widened shape is what `handleSendInput` relies on for image payloads.
    write(message: string | StreamJsonContentBlock[]): void {
      const managed = processManager.get(sessionId);
      if (!managed) {
        throw new Error(`No managed process for session '${sessionId}'`);
      }
      // Fail fast on write-after-exit and write-during-close. Bun's
      // FileSink.write would otherwise silently buffer into a dead process,
      // leaving the caller believing the message was delivered. Matches the
      // F-3 review's "write() silent unbounded buffering" concern.
      if (managed.closing || managed.proc.exitCode !== null) {
        throw new SessionClosed(sessionId, managed.proc.exitCode);
      }
      const framed = buildStreamJsonMessage(message);
      // stdin is typed as `number | FileSink | undefined` in @types/bun because
      // the shape depends on spawn options (we pass `stdin: "pipe"` which gives
      // FileSink). TS cannot narrow from runtime options, hence the explicit
      // check; the throw guards against a future spawn change that would cause
      // a silent drop of principal input.
      const stdin = managed.proc.stdin;
      if (stdin === undefined || typeof stdin === "number") {
        throw new SessionClosed(sessionId, managed.proc.exitCode);
      }
      void stdin.write(framed);
      // NOTE: FileSink backpressure (Promise return from write) is a Phase B
      // concern — Phase A dispatches small principal messages only. When the
      // dispatcher lands, switch to an async write path that awaits
      // stdin.flush() and applies per-session queueing.
    },

    async close(): Promise<void> {
      const managed = processManager.get(sessionId);
      if (!managed) return;

      // Seize cleanup ownership from the auto-exit handler.
      managed.closing = true;

      if (managed.proc.exitCode === null) {
        try {
          managed.proc.kill("SIGTERM");
        } catch (err) {
          process.stderr.write(
            `[endpoint] SIGTERM failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }

        // Wait graceful, escalate to SIGKILL if needed.
        const result = await Promise.race([
          managed.proc.exited.then(() => "exited" as const),
          new Promise<"timeout">((r) => {
            setTimeout(() => { r("timeout"); }, CLOSE_GRACEFUL_TIMEOUT_MS);
          }),
        ]);

        // managed.proc.exitCode is `number | null`; TS narrowed it to null
        // earlier (line 246's `if (managed.proc.exitCode === null)`), but
        // the child can exit during the SIGTERM grace race — the re-check
        // is load-bearing despite the literal-comparison appearing dead.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (result === "timeout" && managed.proc.exitCode === null) {
          try {
            managed.proc.kill("SIGKILL");
          } catch (err) {
            process.stderr.write(
              `[endpoint] SIGKILL failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`
            );
          }
          await managed.proc.exited;
        }
      }

      // Drain the dispatcher before finalizing DB state: events that arrived
      // just before SIGTERM may still be mid-flight. Awaiting ensures they
      // land in the events table while the session is still "open", not
      // orphaned against a session already marked ended.
      if (managed.dispatcherDone) {
        try {
          await managed.dispatcherDone;
        } catch (err) {
          process.stderr.write(
            `[endpoint] dispatcher drain failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }

      processManager.remove(sessionId);
      endSession(db, sessionId);
    },
  };
}

function createObservedEndpoint(sessionId: string): SessionEndpoint {
  return {
    kind: "local.observed",
    sessionId,

    // Signature mirrors SessionEndpoint.write (string | StreamJsonContentBlock[]).
    // Body throws unconditionally — observed sessions reject all writes —
    // so the annotation is purely type hygiene against the widened
    // interface contract introduced with image-input.
    write(_message: string | StreamJsonContentBlock[]): void {
      throw new NotControllable(sessionId);
    },

    async close(): Promise<void> {
      // Observed sessions are external — nothing to kill
    },
  };
}
