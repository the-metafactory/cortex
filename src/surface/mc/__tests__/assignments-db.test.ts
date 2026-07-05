/**
 * S4 (#1518) — unit tests for the assignment mutations lifted out of
 * api/handlers.ts (`createQueuedAssignment`, `deleteAssignment`).
 *
 * Read-side coverage for `db/assignments.ts` (`listAssignments`,
 * `listFocusArea`, `mostActiveAgent`) lives in the endpoint-level tests
 * (api.test.ts, focus-area-ws.test.ts) — this file is scoped to the new
 * write-half functions only.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { createQueuedAssignment, deleteAssignment } from "../db/assignments";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  db.exec(
    `INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`
  );
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);

  return db;
}

interface AssignmentRow {
  id: string;
  agent_id: string;
  task_id: string;
  state: string;
}

function readAssignment(db: Database, id: string): AssignmentRow | null {
  return db
    .query(`SELECT id, agent_id, task_id, state FROM agent_task_assignment WHERE id = ?`)
    .get(id) as AssignmentRow | null;
}

describe("createQueuedAssignment", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("inserts a row that starts in 'queued'", () => {
    createQueuedAssignment(db, { id: "ata-1", agentId: "a-1", taskId: "t-1" });
    expect(readAssignment(db, "ata-1")).toEqual({
      id: "ata-1",
      agent_id: "a-1",
      task_id: "t-1",
      state: "queued",
    });
  });

  it("rejects an unknown agent_id (FK RESTRICT)", () => {
    expect(() =>
      createQueuedAssignment(db, { id: "ata-1", agentId: "ghost", taskId: "t-1" })
    ).toThrow();
  });

  it("rejects an unknown task_id (FK RESTRICT)", () => {
    expect(() =>
      createQueuedAssignment(db, { id: "ata-1", agentId: "a-1", taskId: "ghost" })
    ).toThrow();
  });
});

describe("deleteAssignment", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("removes the row", () => {
    createQueuedAssignment(db, { id: "ata-1", agentId: "a-1", taskId: "t-1" });
    expect(readAssignment(db, "ata-1")).not.toBeNull();
    deleteAssignment(db, "ata-1");
    expect(readAssignment(db, "ata-1")).toBeNull();
  });

  it("is a no-op on an unknown id (no matching row, no throw)", () => {
    expect(() => deleteAssignment(db, "does-not-exist")).not.toThrow();
  });
});
