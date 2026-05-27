import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL, TABLE_NAMES } from "../db/schema";

describe("mission-control schema", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    for (const sql of SCHEMA_SQL) {
      db.exec(sql);
    }
  });

  afterEach(() => {
    db.close();
  });

  it("creates all 5 required tables", () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    for (const name of TABLE_NAMES) {
      expect(tableNames).toContain(name);
    }
  });

  it("inserts and reads a task", () => {
    db.exec(`
      INSERT INTO tasks (id, title, priority, principal_id, source_system, status)
      VALUES ('t-1', 'Fix webhook', 0, 'andreas', 'github', 'open')
    `);
    const row = db.query("SELECT * FROM tasks WHERE id = 't-1'").get() as any;
    expect(row.title).toBe("Fix webhook");
    expect(row.priority).toBe(0);
    expect(row.status).toBe("open");
  });

  it("inserts and reads an agent", () => {
    db.exec(`
      INSERT INTO agents (id, name, type, persistent)
      VALUES ('a-1', 'Luna', 'head', 1)
    `);
    const row = db.query("SELECT * FROM agents WHERE id = 'a-1'").get() as any;
    expect(row.name).toBe("Luna");
    expect(row.type).toBe("head");
    expect(row.persistent).toBe(1);
  });

  it("inserts and reads an assignment with FK to agent and task", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    db.exec(`
      INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
      VALUES ('ata-1', 'a-1', 't-1', 'queued')
    `);
    const row = db.query("SELECT * FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;
    expect(row.state).toBe("queued");
    expect(row.agent_id).toBe("a-1");
    expect(row.task_id).toBe("t-1");
  });

  it("inserts and reads a session with FK to assignment", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
    db.exec(`
      INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind)
      VALUES ('s-1', 'ata-1', 'cc-abc-123', 'local.process.controlled')
    `);
    const row = db.query("SELECT * FROM sessions WHERE id = 's-1'").get() as any;
    expect(row.endpoint_kind).toBe("local.process.controlled");
    expect(row.cc_session_id).toBe("cc-abc-123");
  });

  it("inserts and reads an event with FK to session", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
    db.exec(`INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('s-1', 'ata-1', 'local.process.controlled')`);
    db.exec(`
      INSERT INTO events (id, session_id, type, payload)
      VALUES ('e-1', 's-1', 'tool.bash', '{"command":"ls"}')
    `);
    const row = db.query("SELECT * FROM events WHERE id = 'e-1'").get() as any;
    expect(row.type).toBe("tool.bash");
    expect(JSON.parse(row.payload)).toEqual({ command: "ls" });
  });

  it("enforces state CHECK constraint on assignments", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    expect(() => {
      db.exec(`
        INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
        VALUES ('ata-1', 'a-1', 't-1', 'invalid_state')
      `);
    }).toThrow();
  });

  it("enforces endpoint_kind CHECK constraint on sessions", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
    expect(() => {
      db.exec(`
        INSERT INTO sessions (id, assignment_id, endpoint_kind)
        VALUES ('s-1', 'ata-1', 'invalid_kind')
      `);
    }).toThrow();
  });

  it("creates indices on events and assignments", () => {
    const indices = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as { name: string }[];
    const indexNames = indices.map((i) => i.name);

    expect(indexNames).toContain("idx_events_session_id");
    expect(indexNames).toContain("idx_events_type");
    expect(indexNames).toContain("idx_events_timestamp");
    // Composite for dashboard "last N events for session X" query.
    expect(indexNames).toContain("idx_events_session_timestamp");
    expect(indexNames).toContain("idx_ata_agent_id");
    expect(indexNames).toContain("idx_ata_task_id");
    expect(indexNames).toContain("idx_ata_state");
    expect(indexNames).toContain("idx_sessions_assignment_id");
    // Partial unique: defense-in-depth against concurrent spawn races.
    expect(indexNames).toContain("idx_sessions_active_assignment");
    // Task list view — status filter + priority/updated_at ORDER BY.
    expect(indexNames).toContain("idx_tasks_status_priority_updated");
  });

  // --- FK enforcement ---
  // SQLite's default is foreign_keys=OFF. These tests prove the pragma is on
  // AND the FKs reject bad references — if someone drops the pragma, the
  // four "rejects" tests below fail loudly.

  it("has PRAGMA foreign_keys actually enabled", () => {
    const row = db.query("PRAGMA foreign_keys").get() as any;
    expect(row.foreign_keys).toBe(1);
  });

  it("rejects assignment with nonexistent agent_id", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    expect(() => {
      db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'ghost', 't-1')`);
    }).toThrow();
  });

  it("rejects assignment with nonexistent task_id", () => {
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    expect(() => {
      db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 'ghost')`);
    }).toThrow();
  });

  it("rejects session with nonexistent assignment_id", () => {
    expect(() => {
      db.exec(`INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('s-1', 'ghost', 'local.process.controlled')`);
    }).toThrow();
  });

  it("rejects event with nonexistent session_id", () => {
    expect(() => {
      db.exec(`INSERT INTO events (id, session_id, type) VALUES ('e-1', 'ghost', 'tool.bash')`);
    }).toThrow();
  });

  // --- block_reason invariant ---
  // Schema CHECK: (state = 'blocked') = (block_reason IS NOT NULL).
  // Plus json_valid(block_reason). These tests pin the invariant so
  // any future writer that bypasses the state machine is caught.

  it("rejects state='blocked' with NULL block_reason", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    expect(() => {
      db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason) VALUES ('ata-1', 'a-1', 't-1', 'blocked', NULL)`);
    }).toThrow();
  });

  it("rejects non-blocked state with non-NULL block_reason", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    const reason = JSON.stringify({ kind: "permission.request", payload: { requested_action: "tool.bash" } });
    expect(() => {
      db.query(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason) VALUES (?, ?, ?, ?, ?)`)
        .run("ata-1", "a-1", "t-1", "running", reason);
    }).toThrow();
  });

  it("rejects malformed JSON in block_reason", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    expect(() => {
      db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason) VALUES ('ata-1', 'a-1', 't-1', 'blocked', 'not json')`);
    }).toThrow();
  });

  it("accepts state='blocked' with valid JSON block_reason", () => {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    const reason = JSON.stringify({ kind: "permission.request", payload: { requested_action: "tool.bash" } });
    db.query(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state, block_reason) VALUES (?, ?, ?, ?, ?)`)
      .run("ata-1", "a-1", "t-1", "blocked", reason);
    const row = db.query("SELECT block_reason FROM agent_task_assignment WHERE id = 'ata-1'").get() as any;
    expect(JSON.parse(row.block_reason).kind).toBe("permission.request");
  });

  // --- ON DELETE policies ---
  // CASCADE off sessions->assignment and events->session: detail rows
  // are swept with their parent. RESTRICT off assignment->agent and
  // assignment->task: cannot drop a parent that still has live work.

  function seedFullChain() {
    db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
    db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Agent', 'hands')`);
    db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
    db.exec(`INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('s-1', 'ata-1', 'local.process.controlled')`);
    db.exec(`INSERT INTO events (id, session_id, type) VALUES ('e-1', 's-1', 'tool.bash')`);
  }

  it("CASCADE: deleting a session removes its events", () => {
    seedFullChain();
    db.exec(`DELETE FROM sessions WHERE id = 's-1'`);
    const events = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(events.c).toBe(0);
  });

  it("CASCADE: deleting an assignment removes its sessions and their events", () => {
    seedFullChain();
    db.exec(`DELETE FROM agent_task_assignment WHERE id = 'ata-1'`);
    const sessions = db.query("SELECT COUNT(*) as c FROM sessions").get() as any;
    const events = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(sessions.c).toBe(0);
    expect(events.c).toBe(0);
  });

  it("RESTRICT: blocks deleting an agent that has assignments", () => {
    seedFullChain();
    expect(() => {
      db.exec(`DELETE FROM agents WHERE id = 'a-1'`);
    }).toThrow();
  });

  it("RESTRICT: blocks deleting a task that has assignments", () => {
    seedFullChain();
    expect(() => {
      db.exec(`DELETE FROM tasks WHERE id = 't-1'`);
    }).toThrow();
  });
});
