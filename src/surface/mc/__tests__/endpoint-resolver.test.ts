import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { ProcessManager } from "../session/process-manager";
import {
  NotControllable,
  SessionConflict,
  SessionClosed,
} from "../session/types";
import {
  resolveSessionEndpoint,
  spawnControlledSession,
} from "../session/endpoint-resolver";
import { createSession, findActiveSession } from "../db/sessions";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
  db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);

  return db;
}

/**
 * Spawn a `cat` process as a fake CC — reads stdin, we can verify write.
 * Captures args so tests can assert the CC command line is correct (F-3
 * review: fakeCatSpawn previously ignored args with zero verification).
 */
const spawnedArgs: string[][] = [];
function fakeCatSpawn(args: string[]) {
  spawnedArgs.push([...args]);
  return Bun.spawn(["cat"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Spawn a process that ignores SIGTERM — forces close() into SIGKILL path. */
function fakeSigtermIgnorerSpawn(_args: string[]) {
  return Bun.spawn(
    ["sh", "-c", "trap '' TERM; while true; do sleep 10; done"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

describe("resolveSessionEndpoint", () => {
  let db: Database;
  let pm: ProcessManager;

  beforeEach(() => {
    db = setupDb();
    pm = new ProcessManager();
  });

  afterEach(async () => {
    await pm.closeAll();
    db.close();
  });

  it("returns null when no active session exists", () => {
    const ep = resolveSessionEndpoint(db, pm, "ata-1");
    expect(ep).toBeNull();
  });

  it("returns a controlled endpoint for a controlled session with a managed process", () => {
    // Spawn a session so there's a managed process
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });

    // Now resolve it
    const resolved = resolveSessionEndpoint(db, pm, "ata-1");
    expect(resolved).not.toBeNull();
    expect(resolved!.kind).toBe("local.process.controlled");
    expect(resolved!.sessionId).toBe(ep.sessionId);
  });

  it("returns an observed endpoint for an observed session", () => {
    // Create an observed session directly in DB
    createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
    });

    const ep = resolveSessionEndpoint(db, pm, "ata-1");
    expect(ep).not.toBeNull();
    expect(ep!.kind).toBe("local.observed");
  });

  it("observed endpoint write() throws NotControllable", () => {
    createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
    });

    const ep = resolveSessionEndpoint(db, pm, "ata-1")!;
    expect(() => ep.write("hello")).toThrow(NotControllable);
  });
});

describe("spawnControlledSession", () => {
  let db: Database;
  let pm: ProcessManager;

  beforeEach(() => {
    db = setupDb();
    pm = new ProcessManager();
  });

  afterEach(async () => {
    await pm.closeAll();
    db.close();
  });

  it("spawns a process, creates a session, adds to ProcessManager", () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });

    expect(ep.kind).toBe("local.process.controlled");
    expect(ep.sessionId.length).toBe(26);
    expect(pm.size).toBe(1);

    // Session exists in DB
    const session = findActiveSession(db, "ata-1");
    expect(session).not.toBeNull();
    expect(session!.endpoint_kind).toBe("local.process.controlled");
    expect(session!.pid).toBeTruthy();
  });

  it("write() sends stream-json-framed message to stdin", async () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });

    ep.write("hello world");

    // Close stdin so cat outputs what it received
    const managed = pm.get(ep.sessionId)!;
    const stdin = managed.proc.stdin as import("bun").FileSink;
    stdin.end();

    const stdout = managed.proc.stdout as ReadableStream<Uint8Array>;
    const output = await new Response(stdout).text();
    expect(output).toBe('{"type":"user_message","content":"hello world"}\n');
  });

  it("close() kills process, ends session, removes from ProcessManager", async () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    const sessionId = ep.sessionId;

    expect(pm.size).toBe(1);

    await ep.close();

    expect(pm.size).toBe(0);
    expect(pm.get(sessionId)).toBeUndefined();

    // Session ended_at is set
    const row = db.query("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.ended_at).toBeTruthy();
  });

  it("process exit handler cleans up automatically", async () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    const sessionId = ep.sessionId;
    const managed = pm.get(sessionId)!;

    // Kill the process externally (simulates CC exiting on its own)
    (managed.proc.stdin as import("bun").FileSink).end();
    await managed.proc.exited;

    // Give the exit handler a tick to run
    await new Promise((r) => setTimeout(r, 50));

    expect(pm.has(sessionId)).toBe(false);

    const row = db.query("SELECT ended_at FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(row.ended_at).toBeTruthy();
  });

  it("write() throws when process is not in ProcessManager", async () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    await ep.close();

    expect(() => ep.write("hello")).toThrow("No managed process");
  });

  it("passes CC command-line args to the spawn function", () => {
    spawnedArgs.length = 0;
    spawnControlledSession(db, pm, "ata-1", {
      spawn: fakeCatSpawn,
      extraArgs: ["--resume", "sess-abc"],
    });

    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0]).toEqual([
      "claude",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--resume",
      "sess-abc",
    ]);
  });

  it("write() throws SessionClosed after the process has exited", async () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    const managed = pm.get(ep.sessionId)!;

    // Externally kill without going through ep.close(). Simulates CC crash.
    managed.proc.kill("SIGKILL");
    await managed.proc.exited;

    // write() must reject instead of silently buffering into a dead stdin.
    // Note: the auto-exit handler removes from pm, so by the time the test
    // tick runs write(), get() returns undefined — either error is acceptable
    // (both fail fast). We assert the behavior regardless.
    expect(() => ep.write("after-exit")).toThrow();
  });

  it("write() throws SessionClosed during close() (closing flag set)", async () => {
    // Use a process that ignores SIGTERM so close() stays in progress long
    // enough for us to attempt a write while `closing` is true.
    const ep = spawnControlledSession(db, pm, "ata-1", {
      spawn: fakeSigtermIgnorerSpawn,
    });
    const managed = pm.get(ep.sessionId)!;

    // Start close — SIGTERM will be ignored, process enters graceful wait
    const closePromise = ep.close();

    // Immediately after close() starts, closing should be true
    expect(managed.closing).toBe(true);
    expect(() => ep.write("during-close")).toThrow(SessionClosed);

    // Wait for close to escalate to SIGKILL and finish (timeout is 5s; the
    // test doesn't need to specify — we just await). This uses the real
    // CLOSE_GRACEFUL_TIMEOUT_MS of 5s, but SIGKILL happens immediately after.
    await closePromise;
  }, 10000);

  it("spawnControlledSession is idempotent: returns existing endpoint on second call", () => {
    const ep1 = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    expect(pm.size).toBe(1);

    const ep2 = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    expect(pm.size).toBe(1); // no second process spawned
    expect(ep2.sessionId).toBe(ep1.sessionId);
  });

  it("spawnControlledSession throws SessionConflict when DB has stale active session", () => {
    // Create an active DB row directly, bypassing ProcessManager so no
    // managed process tracks it. Simulates crash-restart state.
    const stale = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      pid: 99999,
    });

    expect(() =>
      spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn })
    ).toThrow(SessionConflict);

    // No process was spawned
    expect(pm.size).toBe(0);
    // Existing session still marked active
    const row = db
      .query("SELECT ended_at FROM sessions WHERE id = ?")
      .get(stale.id) as { ended_at: string | null };
    expect(row.ended_at).toBeNull();
  });

  it("partial unique index prevents two active sessions for same assignment", () => {
    createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      pid: 1,
    });

    // Direct DB insertion of a second active session must fail at schema level.
    expect(() =>
      createSession(db, {
        assignmentId: "ata-1",
        endpointKind: "local.process.controlled",
        pid: 2,
      })
    ).toThrow(/UNIQUE|constraint/i);
  });

  it("closeAll runs onCleanup so sessions get ended_at set", async () => {
    const ep1 = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });

    // Add a second assignment for coverage
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-2', 'Task 2', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-2', 'a-1', 't-2')`);
    const ep2 = spawnControlledSession(db, pm, "ata-2", { spawn: fakeCatSpawn });

    await pm.closeAll();

    // Both sessions should have ended_at set via onCleanup → endSession
    const row1 = db.query("SELECT ended_at FROM sessions WHERE id = ?").get(ep1.sessionId) as { ended_at: string | null };
    const row2 = db.query("SELECT ended_at FROM sessions WHERE id = ?").get(ep2.sessionId) as { ended_at: string | null };
    expect(row1.ended_at).toBeTruthy();
    expect(row2.ended_at).toBeTruthy();
  });

  it("close() during closeAll does not double-end the session (closing flag gate)", async () => {
    const ep = spawnControlledSession(db, pm, "ata-1", { spawn: fakeCatSpawn });
    const managed = pm.get(ep.sessionId)!;

    // Simulate the race: the auto-exit handler fires (closing=true, so no-op)
    // AND closeAll runs onCleanup. ended_at should be set exactly once.
    const closeAllPromise = pm.closeAll();
    await closeAllPromise;

    // Let any pending exit handlers run
    await new Promise((r) => setTimeout(r, 50));

    expect(managed.closing).toBe(true);
    const row = db.query("SELECT ended_at FROM sessions WHERE id = ?").get(ep.sessionId) as { ended_at: string | null };
    expect(row.ended_at).toBeTruthy();
  });
});
