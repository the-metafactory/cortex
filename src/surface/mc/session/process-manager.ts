/**
 * Grove Mission Control v2 — ProcessManager.
 *
 * Map wrapper that holds active CC child processes keyed by session ID.
 * Provides lifecycle management and bulk shutdown with SIGTERM→SIGKILL
 * escalation.
 */

import type { ManagedProcess } from "./types";

/**
 * Grace period a child gets to exit cleanly after SIGTERM before we escalate
 * to SIGKILL in closeAll. 5s matches typical service shutdown budgets and
 * is longer than the Bun CC startup time.
 */
const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;

export interface CloseAllOptions {
  gracefulTimeoutMs?: number;
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  get size(): number {
    return this.processes.size;
  }

  get(sessionId: string): ManagedProcess | undefined {
    return this.processes.get(sessionId);
  }

  add(managed: ManagedProcess): void {
    this.processes.set(managed.sessionId, managed);
  }

  remove(sessionId: string): ManagedProcess | undefined {
    const proc = this.processes.get(sessionId);
    if (proc) {
      this.processes.delete(sessionId);
    }
    return proc;
  }

  has(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }

  /**
   * Kill all managed processes. Called on server shutdown.
   *
   * Protocol:
   *   1. Mark every managed process `closing=true` so the auto-exit handler
   *      registered by endpoint-resolver skips its DB cleanup — closeAll
   *      takes ownership of that via `onCleanup`.
   *   2. SIGTERM every process that is still alive.
   *   3. Wait up to `gracefulTimeoutMs` for them to exit.
   *   4. SIGKILL any stragglers and wait for final exit.
   *   5. Remove from the map and invoke each process's `onCleanup` callback
   *      (typically `endSession(db, sessionId)`).
   *
   * Returns the count of processes that were in the map when closeAll
   * started (i.e. the number we attempted to shut down).
   */
  async closeAll(options?: CloseAllOptions): Promise<number> {
    const gracefulTimeoutMs =
      options?.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
    const entries = [...this.processes.values()];
    if (entries.length === 0) return 0;

    // (1) Mark all as closing so the auto-exit handler cedes cleanup to us.
    for (const m of entries) {
      m.closing = true;
    }

    // (2) SIGTERM anything still alive.
    for (const m of entries) {
      if (m.proc.exitCode === null) {
        try {
          m.proc.kill("SIGTERM");
        } catch (err) {
          // Process may have raced to exit between the check and the signal.
          // Surface via stderr so silent shutdown failures are visible.
          process.stderr.write(
            `[process-manager] SIGTERM failed for ${m.sessionId}: ${(err as Error).message}\n`
          );
        }
      }
    }

    // (3+4) Per-process: await exit up to timeout, escalate to SIGKILL
    // if still running, then await the real exit. Awaiting proc.exited
    // unconditionally in both branches guarantees m.proc.exitCode is
    // populated by the time we finalize — the Promise.race variant can
    // leak past the .then microtask before exitCode settles.
    const TIMEOUT = Symbol("timeout");
    await Promise.all(
      entries.map(async (m) => {
        const result = await Promise.race([
          m.proc.exited,
          new Promise<typeof TIMEOUT>((r) => {
            setTimeout(() => { r(TIMEOUT); }, gracefulTimeoutMs);
          }),
        ]);

        if (result === TIMEOUT && m.proc.exitCode === null) {
          try {
            m.proc.kill("SIGKILL");
          } catch (err) {
            process.stderr.write(
              `[process-manager] SIGKILL failed for ${m.sessionId}: ${(err as Error).message}\n`
            );
          }
          await m.proc.exited;
        }
      })
    );

    // (5) Finalize: drain dispatcher (so trailing events land before
    // endSession), remove from map, and run each onCleanup.
    for (const m of entries) {
      if (m.dispatcherDone) {
        try {
          await m.dispatcherDone;
        } catch (err) {
          process.stderr.write(
            `[process-manager] dispatcher drain failed for ${m.sessionId}: ${(err as Error).message}\n`
          );
        }
      }
      this.processes.delete(m.sessionId);
      if (m.onCleanup) {
        try {
          await m.onCleanup();
        } catch (err) {
          process.stderr.write(
            `[process-manager] onCleanup failed for ${m.sessionId}: ${(err as Error).message}\n`
          );
        }
      }
    }

    return entries.length;
  }
}
