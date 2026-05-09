import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { insertEvent, createOperatorInputEvent, createPermissionRequestEvent, generateId } from "../db/events";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  // seed required parent rows
  db.exec(`INSERT INTO tasks (id, title, priority, operator_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
  db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
  db.exec(`INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('s-1', 'ata-1', 'local.process.controlled')`);

  return db;
}

describe("generateId", () => {
  it("generates 26-character uppercase strings", () => {
    const id = generateId();
    expect(id.length).toBe(26);
    expect(id).toBe(id.toUpperCase());
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  // Monotonic guarantee: even within a single ms (where Date.now() returns
  // identical values across rapid successive calls), the per-process counter
  // ensures lex order matches generation order.
  it("preserves lex order across rapid same-ms calls", () => {
    const ids = Array.from({ length: 50 }, () => generateId());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});

describe("insertEvent", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts an event and returns it with all fields", () => {
    const event = insertEvent(db, {
      sessionId: "s-1",
      type: "tool.bash",
      payload: { command: "ls -la" },
    });

    expect(event.id.length).toBe(26);
    expect(event.session_id).toBe("s-1");
    expect(event.type).toBe("tool.bash");
    expect(event.payload).toEqual({ command: "ls -la" });
    expect(event.timestamp).toBeTruthy();
  });

  it("persists to database", () => {
    const event = insertEvent(db, {
      sessionId: "s-1",
      type: "assistant.message",
      payload: { text: "hello" },
    });

    const row = db.query("SELECT * FROM events WHERE id = ?").get(event.id) as any;
    expect(row).toBeTruthy();
    expect(row.type).toBe("assistant.message");
    expect(JSON.parse(row.payload)).toEqual({ text: "hello" });
  });

  it("enforces FK to sessions", () => {
    expect(() => {
      insertEvent(db, {
        sessionId: "nonexistent",
        type: "test",
        payload: {},
      });
    }).toThrow();
  });
});

describe("createOperatorInputEvent", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates an operator.input event with text payload", () => {
    const event = createOperatorInputEvent(db, "s-1", {
      text: "Please use the v2 API instead",
    });

    expect(event.type).toBe("operator.input");
    expect(event.payload).toEqual({ text: "Please use the v2 API instead" });
  });

  it("creates an operator.input event with attachments", () => {
    const event = createOperatorInputEvent(db, "s-1", {
      text: "See screenshot",
      attachments: ["/tmp/screenshot.png"],
    });

    expect(event.type).toBe("operator.input");
    expect(event.payload).toEqual({
      text: "See screenshot",
      attachments: ["/tmp/screenshot.png"],
    });
  });
});

describe("createPermissionRequestEvent", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates a permission.request event with full payload", () => {
    const event = createPermissionRequestEvent(db, "s-1", {
      requested_action: "tool.bash",
      target: "rm -rf /tmp/build",
      context: "Cleaning build artifacts",
      risk_hint: "medium",
    });

    expect(event.type).toBe("permission.request");
    expect(event.payload).toEqual({
      requested_action: "tool.bash",
      target: "rm -rf /tmp/build",
      context: "Cleaning build artifacts",
      risk_hint: "medium",
    });
  });

  it("creates a permission.request event with minimal payload", () => {
    const event = createPermissionRequestEvent(db, "s-1", {
      requested_action: "tool.edit",
    });

    expect(event.type).toBe("permission.request");
    expect(event.payload).toEqual({ requested_action: "tool.edit" });
  });
});
