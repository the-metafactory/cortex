import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { createSession, findActiveSession, endSession } from "../db/sessions";

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

describe("createSession", () => {
  let db: Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it("creates a controlled session with all fields", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      ccSessionId: "cc-abc-123",
      pid: 12345,
    });

    expect(session.id.length).toBe(26);
    expect(session.assignment_id).toBe("ata-1");
    expect(session.endpoint_kind).toBe("local.process.controlled");
    expect(session.cc_session_id).toBe("cc-abc-123");
    expect(session.pid).toBe(12345);
    expect(session.started_at).toBeTruthy();
    expect(session.ended_at).toBeNull();
  });

  it("creates an observed session without pid or cc_session_id", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
    });

    expect(session.endpoint_kind).toBe("local.observed");
    expect(session.cc_session_id).toBeNull();
    expect(session.pid).toBeNull();
  });

  it("persists to database", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      pid: 99,
    });

    const row = db.query("SELECT * FROM sessions WHERE id = ?").get(session.id) as any;
    expect(row).toBeTruthy();
    expect(row.pid).toBe(99);
  });

  // --- ST-P0 / ADR-0011 canonical session columns ---

  it("defaults substrate to 'claude-code' when not provided", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
    });
    expect(session.substrate).toBe("claude-code");
    expect(session.parent_session_id).toBeNull();

    const row = db.query("SELECT substrate, parent_session_id FROM sessions WHERE id = ?").get(session.id) as any;
    expect(row.substrate).toBe("claude-code");
    expect(row.parent_session_id).toBeNull();
  });

  it("writes parentSessionId and substrate when provided", () => {
    const parent = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
    });
    // End the parent so the partial unique index idx_sessions_active_assignment
    // (one open session per assignment) permits the child on the same assignment.
    endSession(db, parent.id);
    const child = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
      parentSessionId: parent.id,
      substrate: "codex",
    });

    expect(child.parent_session_id).toBe(parent.id);
    expect(child.substrate).toBe("codex");

    const row = db
      .query("SELECT substrate, parent_session_id FROM sessions WHERE id = ?")
      .get(child.id) as any;
    expect(row.substrate).toBe("codex");
    expect(row.parent_session_id).toBe(parent.id);
  });

  it("writes the denormalized canonical columns when provided", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.observed",
      agentId: "luna",
      agentName: "Luna",
      principalId: "andreas",
      status: "running",
    });

    expect(session.agent_id).toBe("luna");
    expect(session.agent_name).toBe("Luna");
    expect(session.principal_id).toBe("andreas");
    expect(session.status).toBe("running");

    const row = db
      .query("SELECT agent_id, agent_name, principal_id, status FROM sessions WHERE id = ?")
      .get(session.id) as any;
    expect(row.agent_id).toBe("luna");
    expect(row.agent_name).toBe("Luna");
    expect(row.principal_id).toBe("andreas");
    expect(row.status).toBe("running");
  });

  it("leaves new canonical columns NULL when not provided (no behavior change for existing callers)", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
    });
    expect(session.agent_id).toBeNull();
    expect(session.agent_name).toBeNull();
    expect(session.principal_id).toBeNull();
    expect(session.status).toBeNull();
    expect(session.parent_session_id).toBeNull();

    const row = db
      .query("SELECT agent_id, agent_name, principal_id, status FROM sessions WHERE id = ?")
      .get(session.id) as any;
    expect(row.agent_id).toBeNull();
    expect(row.agent_name).toBeNull();
    expect(row.principal_id).toBeNull();
    expect(row.status).toBeNull();
  });

  it("enforces the parent_session_id self-FK", () => {
    expect(() => {
      createSession(db, {
        assignmentId: "ata-1",
        endpointKind: "local.observed",
        parentSessionId: "ghost-session",
      });
    }).toThrow();
  });
});

describe("findActiveSession", () => {
  let db: Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it("returns the active session (no ended_at)", () => {
    const created = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      pid: 100,
    });

    const found = findActiveSession(db, "ata-1");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.pid).toBe(100);
  });

  it("returns null when no active session exists", () => {
    const found = findActiveSession(db, "ata-1");
    expect(found).toBeNull();
  });

  it("returns null when all sessions have ended", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
    });
    endSession(db, session.id);

    const found = findActiveSession(db, "ata-1");
    expect(found).toBeNull();
  });

  it("returns the most recent active session when multiple exist", () => {
    const s1 = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      pid: 1,
    });
    endSession(db, s1.id);

    const s2 = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
      pid: 2,
    });

    const found = findActiveSession(db, "ata-1");
    expect(found!.id).toBe(s2.id);
    expect(found!.pid).toBe(2);
  });
});

describe("endSession", () => {
  let db: Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it("sets ended_at on the session", () => {
    const session = createSession(db, {
      assignmentId: "ata-1",
      endpointKind: "local.process.controlled",
    });

    expect(session.ended_at).toBeNull();

    endSession(db, session.id);

    const row = db.query("SELECT ended_at FROM sessions WHERE id = ?").get(session.id) as any;
    expect(row.ended_at).toBeTruthy();
  });
});
