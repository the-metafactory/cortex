/**
 * Grove Mission Control v2 — F-12 Decision 11 process-kill observer.
 *
 * The observer is the load-bearing piece of F-12: without it, Abandon /
 * Hand-off / Requeue leave zombie subprocesses (see addendum Decision 11
 * for the full rationale).
 *
 * This file pins the observer policy and the integration with the curation
 * endpoints. Two layers:
 *   1. Pure-policy tests on `shouldCloseSessionOnTransition` — the matrix.
 *   2. End-to-end tests via the HTTP endpoints + a fake `cat` spawn:
 *      - Abandon on running closes the source process.
 *      - Hand-off on running closes the source process AND spawns a new one.
 *      - Requeue from blocked closes the blocked process.
 *      - Requeue from failed does NOT attempt to kill (no managed process
 *        exists anyway — failed terminates via `proc.exited` cleanup).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { startServer } from "../server";
import type { ServerContext } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";
import { ProcessManager } from "../session/process-manager";
import type { SpawnFn } from "../session/endpoint-resolver";
import {
  observeTransitionForCancel,
  shouldCloseSessionOnTransition,
} from "../notifications";
import { applyTransition } from "../db/transitions";
import type { ManagedProcess } from "../session/types";

const fakeCatSpawn: SpawnFn = () =>
  Bun.spawn(["cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

interface TestContext {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

function makePort(): number {
  return 22000 + Math.floor(Math.random() * 1000);
}

async function setup(): Promise<TestContext> {
  const tmpDir = join(
    tmpdir(),
    `mc-f12-kill-${Date.now()}-${Math.random()}`
  );
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const port = makePort();
  const ctx = startServer(
    { ...DEFAULT_CONFIG, port },
    db,
    { processManager: pm, spawn: fakeCatSpawn }
  );
  return { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
}

async function teardown(t: TestContext): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

/**
 * Wait for the Decision 11 observer's fire-and-forget `closeSession()` chain
 * to finish removing a session from the ProcessManager.
 *
 * Why this exists: the abandon / requeue HTTP handlers schedule the kill via
 * `void fireCancelObserver(...)` and return 200 immediately. The close path
 * is `SIGTERM → await proc.exited → drain dispatcher → pm.remove → endSession`.
 * A test that only awaits `proc.proc.exited` and then asserts on
 * `pm.get(sessionId)` is racing two microtask continuations of the same
 * `proc.exited` promise — under full-suite parallelism the test's continuation
 * sometimes fires before the observer's continuation reaches `pm.remove`.
 *
 * Polling here pins the test to the side effect we actually care about
 * (session no longer tracked) instead of the proxy we used to await
 * (process exited). Production observer is unchanged — see Decision 11
 * in docs/design-mc-f12-task-curation.md.
 */
async function waitForSessionRemoval(
  pm: ProcessManager,
  sessionId: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pm.get(sessionId) === undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for session ${sessionId} to be removed from ProcessManager`
  );
}

// ============================================================================
// Pure-policy: shouldCloseSessionOnTransition
// ============================================================================

describe("shouldCloseSessionOnTransition (Decision 11 policy)", () => {
  it("returns true when transitioning into cancelled (any source state)", () => {
    expect(shouldCloseSessionOnTransition("queued", "cancelled", "cancel")).toBe(
      true
    );
    expect(
      shouldCloseSessionOnTransition("dispatched", "cancelled", "cancel")
    ).toBe(true);
    expect(shouldCloseSessionOnTransition("running", "cancelled", "cancel")).toBe(
      true
    );
    expect(shouldCloseSessionOnTransition("blocked", "cancelled", "cancel")).toBe(
      true
    );
  });

  it("returns true on principal_requeue from blocked (live process exists)", () => {
    expect(
      shouldCloseSessionOnTransition("blocked", "queued", "principal_requeue")
    ).toBe(true);
  });

  it("returns false on principal_requeue from failed (no live process)", () => {
    expect(
      shouldCloseSessionOnTransition("failed", "queued", "principal_requeue")
    ).toBe(false);
  });

  it("returns false on regular non-cancel transitions", () => {
    expect(shouldCloseSessionOnTransition("queued", "dispatched", "dispatch")).toBe(
      false
    );
    expect(
      shouldCloseSessionOnTransition("dispatched", "running", "start")
    ).toBe(false);
    expect(shouldCloseSessionOnTransition("running", "completed", "complete")).toBe(
      false
    );
    expect(shouldCloseSessionOnTransition("running", "failed", "fail")).toBe(
      false
    );
  });
});

// ============================================================================
// observeTransitionForCancel — fake processManager wiring
// ============================================================================

describe("observeTransitionForCancel (with fake processManager)", () => {
  it("calls closeSession when policy matches AND a live managed process is tracked", async () => {
    const calls: string[] = [];
    const fakeManaged = {
      proc: { exitCode: null } as { exitCode: number | null },
      sessionId: "s-1",
      assignmentId: "ata-1",
      spawnedAt: Date.now(),
      closing: false,
    } as unknown as ManagedProcess;
    const fakePm = {
      get: (sid: string) => (sid === "s-1" ? fakeManaged : undefined),
    } as unknown as ProcessManager;

    const promise = observeTransitionForCancel(
      {
        processManager: fakePm,
        closeSession: async (sid: string) => {
          calls.push(sid);
        },
      },
      "s-1",
      "running",
      "cancelled",
      "cancel"
    );
    expect(promise).not.toBeNull();
    await promise;
    expect(calls).toEqual(["s-1"]);
  });

  it("returns null (no kill) when policy does not match", () => {
    const fakePm = {
      get: () => ({}) as ManagedProcess,
    } as unknown as ProcessManager;
    const result = observeTransitionForCancel(
      {
        processManager: fakePm,
        closeSession: async () => {
          throw new Error("should not run");
        },
      },
      "s-1",
      "running",
      "completed", // happy-path complete
      "complete"
    );
    expect(result).toBeNull();
  });

  it("returns null when no managed process tracked (already exited)", () => {
    const fakePm = {
      get: () => undefined,
    } as unknown as ProcessManager;
    const result = observeTransitionForCancel(
      {
        processManager: fakePm,
        closeSession: async () => {
          throw new Error("should not run");
        },
      },
      "s-1",
      "running",
      "cancelled",
      "cancel"
    );
    expect(result).toBeNull();
  });

  it("returns null when managed process is already closing", () => {
    const closingManaged = {
      proc: { exitCode: null },
      sessionId: "s-1",
      closing: true,
    } as unknown as ManagedProcess;
    const fakePm = {
      get: () => closingManaged,
    } as unknown as ProcessManager;
    const result = observeTransitionForCancel(
      {
        processManager: fakePm,
        closeSession: async () => {
          throw new Error("should not run");
        },
      },
      "s-1",
      "running",
      "cancelled",
      "cancel"
    );
    expect(result).toBeNull();
  });

  it("swallows closeSession rejections (best-effort enforcement)", async () => {
    const fakeManaged = {
      proc: { exitCode: null },
      sessionId: "s-1",
      closing: false,
    } as unknown as ManagedProcess;
    const fakePm = {
      get: () => fakeManaged,
    } as unknown as ProcessManager;
    const promise = observeTransitionForCancel(
      {
        processManager: fakePm,
        closeSession: async () => {
          throw new Error("kill failed");
        },
      },
      "s-1",
      "running",
      "cancelled",
      "cancel"
    );
    expect(promise).not.toBeNull();
    // Must not reject — swallowed via .catch in the observer.
    await expect(promise).resolves.toBeUndefined();
  });
});

// ============================================================================
// End-to-end with HTTP + fake cat: Abandon, Hand-off, Requeue close processes
// ============================================================================

describe("F-12 endpoints close live processes (Decision 11 wiring)", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

  /** Spawn a controlled session via POST /api/sessions, return its ids. */
  async function spawnRunning(): Promise<{
    assignmentId: string;
    sessionId: string;
    proc: ManagedProcess;
  }> {
    const res = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "for-kill" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const proc = t.pm.get(body.sessionId);
    expect(proc).toBeDefined();
    return {
      assignmentId: body.assignmentId,
      sessionId: body.sessionId,
      proc: proc!,
    };
  }

  it("Abandon on running closes the live process", async () => {
    const { assignmentId, sessionId, proc } = await spawnRunning();
    expect(proc.proc.exitCode).toBeNull();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

    // Wait for the observer's fire-and-forget closeSession chain to land.
    // See `waitForSessionRemoval` preamble for the race we're avoiding —
    // `await proc.proc.exited` alone is racy because the test's continuation
    // and the observer's continuation are both .then() callers on the same
    // exit promise.
    await waitForSessionRemoval(t.pm, sessionId);
    expect(t.pm.get(sessionId)).toBeUndefined();
  });

  it("Hand-off on running closes the source process AND a new one is spawned", async () => {
    const { assignmentId, sessionId, proc } = await spawnRunning();
    t.db
      .query(
        `INSERT OR IGNORE INTO agents (id, name, type) VALUES ('agent-target', 'Target', 'hands')`
      )
      .run();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "agent-target" }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Source process: dead and removed from the manager. Use the polling
    // helper for the same reason as the Abandon test — the observer's
    // post-exit cleanup races the test's `proc.exited` continuation.
    await waitForSessionRemoval(t.pm, sessionId);
    expect(t.pm.get(sessionId)).toBeUndefined();

    // New process: alive and tracked.
    const newProc = t.pm.get(body.newSessionId);
    expect(newProc).toBeDefined();
    expect(newProc!.proc.exitCode).toBeNull();
  });

  it("Requeue from running rejects (Decision 3 — disabled), no kill", async () => {
    // Requeue from running is illegal — addendum Decision 3 disables it.
    // This pins that the policy matrix isn't bypassed.
    const { assignmentId, sessionId, proc } = await spawnRunning();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(409);
    // Process untouched.
    expect(proc.proc.exitCode).toBeNull();
    expect(t.pm.get(sessionId)).toBeDefined();
  });

  it("Requeue from blocked closes the blocked process (state.transition observer fires)", async () => {
    // Drive the running session into `blocked` via applyTransition directly,
    // matching the addendum's "live blocked process" scenario.
    const { assignmentId, sessionId, proc } = await spawnRunning();
    const result = applyTransition(t.db, assignmentId, sessionId, {
      type: "block",
      reason: {
        kind: "permission.request",
        payload: { requested_action: "tool.edit" },
      },
    });
    expect(result.ok).toBe(true);

    // Sanity: process still alive in the blocked state.
    expect(proc.proc.exitCode).toBeNull();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

    // Observer kills the live process. Use the polling helper to await the
    // post-exit pm.remove step, not just proc.exited (see helper preamble).
    await waitForSessionRemoval(t.pm, sessionId);
    expect(t.pm.get(sessionId)).toBeUndefined();
  });
});

// ============================================================================
// PR #30 S1 — Hand-off ordering invariant (Decision 6: close OLD before spawn NEW)
// ============================================================================
//
// The prior "Hand-off on running closes the source process AND a new one is
// spawned" test only asserts "old is dead, new is alive" post-hoc, which is
// satisfied by either ordering. This suite pins the ORDER via a recording
// spawn wrapper + a promise on the old process's `.exited`, so an inverted
// implementation (spawn-first-then-kill) fails here deterministically.
//
// Kept in its own describe so the recording-spawn context does not mutate
// the outer suite's shared fixture.

describe("Hand-off ordering (PR #30 S1)", () => {
  let t: TestContext;
  const sequence: string[] = [];

  beforeEach(async () => {
    sequence.length = 0;
    const recordingSpawn: SpawnFn = () => {
      sequence.push("spawn");
      return Bun.spawn(["cat"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    };

    const tmpDir = join(
      tmpdir(),
      `mc-f12-kill-seq-${Date.now()}-${Math.random()}`
    );
    const db = initDatabase(join(tmpDir, "test.db"));
    const pm = new ProcessManager();
    const port = makePort();
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port },
      db,
      { processManager: pm, spawn: recordingSpawn }
    );
    t = {
      db,
      ctx,
      pm,
      port,
      baseUrl: `http://localhost:${port}`,
      tmpDir,
    };
  });

  afterEach(async () => {
    await teardown(t);
  });

  it("closes the OLD process BEFORE spawning the NEW one (Decision 6 ordering)", async () => {
    // Spawn the source session. Records "spawn" #1 via the recording wrapper.
    const created = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "order-test" }),
    });
    expect(created.status).toBe(201);
    const { assignmentId, sessionId } = await created.json();
    const oldProc = t.pm.get(sessionId)!;
    expect(oldProc).toBeDefined();

    // When the OLD process actually exits, record "old-exited" in the
    // sequence. If close-before-spawn is wired correctly, "old-exited" lands
    // BEFORE the handoff's internal spawn appends the second "spawn".
    void oldProc.proc.exited.then(() => sequence.push("old-exited"));

    t.db
      .query(
        `INSERT OR IGNORE INTO agents (id, name, type) VALUES ('agent-target', 'Target', 'hands')`
      )
      .run();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/handoff`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newAgentId: "agent-target" }),
      }
    );
    expect(res.status).toBe(200);

    // Expected order: spawn (original) → old-exited → spawn (new). An
    // inverted implementation (spawn new first, then await kill) would
    // produce ["spawn", "spawn", "old-exited"] and fail this assertion.
    expect(sequence).toEqual(["spawn", "old-exited", "spawn"]);
  });
});
