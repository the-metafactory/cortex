import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
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

const _realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("Cf-Access-Authenticated-User-Email")) {
      headers.set("Cf-Access-Authenticated-User-Email", "principal@example.com");
    }
    return _realFetch(input, { ...init, headers });
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = _realFetch;
});

interface TestContext {
  db: Database;
  ctx: ServerContext;
  pm: ProcessManager;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

async function setup(): Promise<TestContext> {
  const tmpDir = join(
    tmpdir(),
    `mc-f12-kill-${Date.now()}-${Math.random()}`
  );
  const db = initDatabase(join(tmpDir, "test.db"));
  const pm = new ProcessManager();
  const ctx = startServer(
    { ...DEFAULT_CONFIG, port: 0 },
    db,
    { processManager: pm, spawn: fakeCatSpawn }
  );
  const port = ctx.port;
  return { db, ctx, pm, port, baseUrl: `http://localhost:${port}`, tmpDir };
}

async function teardown(t: TestContext): Promise<void> {
  await t.pm.closeAll();
  t.ctx.stop(true);
  t.db.close();
  rmSync(t.tmpDir, { recursive: true, force: true });
}

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
      "completed",
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
    await expect(promise).resolves.toBeUndefined();
  });
});

describe("F-12 endpoints close live processes (Decision 11 wiring)", () => {
  let t: TestContext;
  beforeEach(async () => {
    t = await setup();
  });
  afterEach(async () => {
    await teardown(t);
  });

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

  function blockLiveSessionOnPermissionRequest(
    assignmentId: string,
    sessionId: string
  ): void {
    const result = applyTransition(t.db, assignmentId, sessionId, {
      type: "block",
      reason: {
        kind: "permission.request",
        payload: { requested_action: "tool.edit" },
      },
    });
    expect(result.ok).toBe(true);
  }

  it("Abandon on running closes the live process", async () => {
    const { assignmentId, sessionId, proc } = await spawnRunning();
    expect(proc.proc.exitCode).toBeNull();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/abandon`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

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

    await waitForSessionRemoval(t.pm, sessionId);
    expect(t.pm.get(sessionId)).toBeUndefined();

    const newProc = t.pm.get(body.newSessionId);
    expect(newProc).toBeDefined();
    expect(newProc!.proc.exitCode).toBeNull();
  });

  it("Requeue from running rejects (Decision 3 — disabled), no kill", async () => {
    const { assignmentId, sessionId, proc } = await spawnRunning();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(409);
    expect(proc.proc.exitCode).toBeNull();
    expect(t.pm.get(sessionId)).toBeDefined();
  });

  it("Requeue from blocked closes the blocked process (state.transition observer fires)", async () => {
    const { assignmentId, sessionId, proc } = await spawnRunning();
    blockLiveSessionOnPermissionRequest(assignmentId, sessionId);

    expect(proc.proc.exitCode).toBeNull();

    const res = await fetch(
      `${t.baseUrl}/api/assignments/${assignmentId}/requeue`,
      { method: "POST" }
    );
    expect(res.status).toBe(200);

    await waitForSessionRemoval(t.pm, sessionId);
    expect(t.pm.get(sessionId)).toBeUndefined();
  });
});

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
    const ctx = startServer(
      { ...DEFAULT_CONFIG, port: 0 },
      db,
      { processManager: pm, spawn: recordingSpawn }
    );
    const port = ctx.port;
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
    const created = await fetch(`${t.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "order-test" }),
    });
    expect(created.status).toBe(201);
    const { assignmentId, sessionId } = await created.json();
    const oldProc = t.pm.get(sessionId)!;
    expect(oldProc).toBeDefined();

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

    const spawnOriginalThenOldExitedThenSpawnNew = ["spawn", "old-exited", "spawn"];
    expect(sequence).toEqual(spawnOriginalThenOldExitedThenSpawnNew);
  });
});
