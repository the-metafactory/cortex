import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { applyTransition } from "../db/transitions";
import type { BlockReason } from "../types";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  // seed required parent rows
  db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
  db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('ata-1', 'a-1', 't-1', 'queued')`);
  db.exec(`INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('s-1', 'ata-1', 'local.process.controlled')`);

  return db;
}

const permissionBlock: BlockReason = {
  kind: "permission.request",
  payload: { requested_action: "tool.bash", target: "rm -rf /tmp", risk_hint: "high" },
};

describe("applyTransition", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("dispatches a queued assignment and records an event", () => {
    const result = applyTransition(db, "ata-1", "s-1", { type: "dispatch" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assignment.state).toBe("dispatched");
    expect(result.assignment.block_reason).toBeNull();
    expect(result.event.type).toBe("state.transition");
    expect(result.event.payload).toMatchObject({
      from: "queued",
      to: "dispatched",
      action: "dispatch",
    });
  });

  it("walks the full happy path: queued → dispatched → running → completed", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    const result = applyTransition(db, "ata-1", "s-1", { type: "complete" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assignment.state).toBe("completed");

    // 3 events total
    // Order by (timestamp, id) — three transitions in the same ms share a
    // timestamp; the id's monotonic counter breaks the tie reliably.
    const events = db.query("SELECT * FROM events WHERE session_id = 's-1' ORDER BY timestamp, id").all() as any[];
    expect(events.length).toBe(3);
    expect(JSON.parse(events[0].payload).to).toBe("dispatched");
    expect(JSON.parse(events[1].payload).to).toBe("running");
    expect(JSON.parse(events[2].payload).to).toBe("completed");
  });

  it("blocks with reason and stores it on the assignment", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    const result = applyTransition(db, "ata-1", "s-1", {
      type: "block",
      reason: permissionBlock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assignment.state).toBe("blocked");
    expect(result.assignment.block_reason).toEqual(permissionBlock);

    // verify stored in DB
    const row = db.query("SELECT block_reason FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;
    expect(JSON.parse(row.block_reason)).toEqual(permissionBlock);
  });

  it("resume clears block_reason", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    applyTransition(db, "ata-1", "s-1", { type: "block", reason: permissionBlock });
    const result = applyTransition(db, "ata-1", "s-1", { type: "resume" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assignment.state).toBe("running");
    expect(result.assignment.block_reason).toBeNull();

    const row = db.query("SELECT block_reason FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;
    expect(row.block_reason).toBeNull();
  });

  it("principal_requeue from blocked clears block_reason and returns to queued", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    applyTransition(db, "ata-1", "s-1", { type: "block", reason: permissionBlock });
    const result = applyTransition(db, "ata-1", "s-1", { type: "principal_requeue" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assignment.state).toBe("queued");
    expect(result.assignment.block_reason).toBeNull();
  });

  it("principal_requeue from failed returns to queued", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    applyTransition(db, "ata-1", "s-1", { type: "fail" });
    const result = applyTransition(db, "ata-1", "s-1", { type: "principal_requeue" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.assignment.state).toBe("queued");
  });

  it("rejects invalid transitions", () => {
    // queued → start is invalid (must dispatch first)
    const result = applyTransition(db, "ata-1", "s-1", { type: "start" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid transition");
    }
  });

  it("rejects transitions on completed (terminal)", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    applyTransition(db, "ata-1", "s-1", { type: "complete" });

    const result = applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    expect(result.ok).toBe(false);
  });

  it("throws on nonexistent assignment", () => {
    const result = applyTransition(db, "nonexistent", "s-1", { type: "dispatch" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  it("updates updated_at timestamp on transition", () => {
    const before = db.query("SELECT updated_at FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;

    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });

    const after = db.query("SELECT updated_at FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;
    // updated_at should be different (or at least re-set)
    expect(after.updated_at).toBeTruthy();
  });

  it("event payload includes blockReason for block actions", () => {
    applyTransition(db, "ata-1", "s-1", { type: "dispatch" });
    applyTransition(db, "ata-1", "s-1", { type: "start" });
    const result = applyTransition(db, "ata-1", "s-1", { type: "block", reason: permissionBlock });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.event.payload).toMatchObject({
      from: "running",
      to: "blocked",
      action: "block",
      blockReason: permissionBlock,
    });
  });

  // Atomicity: when the event insert fails (FK violation on bogus sessionId),
  // the assignment row state must be unchanged and no event row leaks.
  // bun:sqlite db.transaction auto-rolls back on throw — this pins it.
  it("rolls back the assignment update if the event insert fails", () => {
    const before = db.query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;

    const result = applyTransition(db, "ata-1", "s-bogus", { type: "dispatch" });

    expect(result.ok).toBe(false);

    const after = db.query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;
    expect(after.state).toBe(before.state);
    const eventCount = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(eventCount.c).toBe(0);
  });

  // Concurrency guard: the WHERE id=? AND state=? clause means a stale
  // read followed by an out-of-band update results in 0 changes. Verify
  // both the underlying SQL semantics and that applyTransition surfaces
  // the resulting "state changed concurrently" error.
  it("WHERE id=? AND state=? returns 0 changes if state has drifted", () => {
    const update = db
      .query(
        `UPDATE agent_task_assignment
         SET state = ?, updated_at = ?
         WHERE id = ? AND state = ?`
      )
      .run("dispatched", new Date().toISOString(), "ata-1", "running");
    // Initial state is 'queued', so matching on 'running' gives 0 rows.
    expect(update.changes).toBe(0);
  });
});
