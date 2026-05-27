import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { ingestEvents } from "../hooks/ingestor";
import type { RawHookEvent } from "../hooks/types";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  // Seed: task → agent → assignment → observed session with cc_session_id
  db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Luna', 'head')`);
  db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
  db.exec(
    `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind)
     VALUES ('s-obs', 'ata-1', 'cc-session-abc', 'local.observed')`
  );

  return db;
}

function makeRawEvent(
  eventId: string,
  sessionId: string,
  eventType = "test.event"
): RawHookEvent {
  return {
    event_id: eventId,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    agent_id: "luna",
    agent_name: "Luna",
    source: { hook: "PostToolUse", tool_name: "tool.bash" },
    payload: { test: true },
  };
}

describe("ingestEvents", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("ingests events matching a registered session", () => {
    const events = [
      makeRawEvent("e-1", "cc-session-abc", "tool.bash"),
      makeRawEvent("e-2", "cc-session-abc", "assistant.message"),
    ];

    const result = ingestEvents(db, events);
    expect(result.count).toBe(2);
    expect(result.events).toHaveLength(2);

    // Order explicitly by id ASC — without an ORDER BY SQLite may return rows
    // in any order the chosen index walks them (the (session_id, id DESC)
    // composite would yield reverse order). id is ULID-monotonic so ASC
    // matches insertion order.
    const rows = db
      .query("SELECT * FROM events WHERE session_id = 's-obs' ORDER BY id ASC")
      .all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("tool.bash");
    expect(rows[1].type).toBe("assistant.message");
  });

  it("skips events from unregistered sessions", () => {
    const events = [
      makeRawEvent("e-1", "unknown-session-xyz"),
    ];

    const result = ingestEvents(db, events);
    expect(result.count).toBe(0);
    expect(result.events).toHaveLength(0);

    const rows = db.query("SELECT * FROM events").all();
    expect(rows).toHaveLength(0);
  });

  it("handles mixed registered and unregistered sessions", () => {
    const events = [
      makeRawEvent("e-1", "cc-session-abc"),   // matched
      makeRawEvent("e-2", "unknown-session"),   // not matched
      makeRawEvent("e-3", "cc-session-abc"),   // matched
    ];

    const result = ingestEvents(db, events);
    expect(result.count).toBe(2);
  });

  it("returns 0 for empty events array", () => {
    const result = ingestEvents(db, []);
    expect(result.count).toBe(0);
    expect(result.events).toHaveLength(0);
  });

  it("preserves source metadata in payload", () => {
    const events = [makeRawEvent("e-1", "cc-session-abc", "tool.bash")];
    ingestEvents(db, events);

    const row = db.query("SELECT payload FROM events LIMIT 1").get() as any;
    const payload = JSON.parse(row.payload);
    expect(payload.source_hook).toBe("PostToolUse");
    expect(payload.source_tool).toBe("tool.bash");
    expect(payload.agent_name).toBe("Luna");
    expect(payload.original_event_id).toBe("e-1");
  });

  it("still ingests events for ended sessions (events can lag lifecycle)", () => {
    // End the session — simulates auto-exit handler marking ended_at before
    // the ingestor processes remaining events (especially session.end itself).
    db.exec(`UPDATE sessions SET ended_at = datetime('now') WHERE id = 's-obs'`);

    const events = [makeRawEvent("e-1", "cc-session-abc", "session.end")];
    const result = ingestEvents(db, events);

    // Should still ingest — events are facts about what happened, and the
    // session.end event is the most important lifecycle marker.
    expect(result.count).toBe(1);

    const rows = db.query("SELECT * FROM events WHERE session_id = 's-obs'").all();
    expect(rows).toHaveLength(1);
  });

  it("logs unregistered session drops to stderr", () => {
    const written: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk: string) => {
      written.push(chunk);
      return true;
    };

    try {
      const events = [makeRawEvent("e-1", "totally-unknown-session")];
      const result = ingestEvents(db, events);

      expect(result.count).toBe(0);
      expect(written.some((s) => s.includes("unregistered session"))).toBe(true);
      expect(written.some((s) => s.includes("totally-unknown-session"))).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  // F-20 — observed sessions auto-transition `dispatched → running` on the
  // first event ingested. Pin the assignment to `dispatched` (the state
  // POST /api/sessions leaves observed sessions in) before ingesting.
  it("auto-transitions observed dispatched → running on first event", () => {
    db.exec(
      `UPDATE agent_task_assignment SET state = 'dispatched' WHERE id = 'ata-1'`
    );
    const events = [makeRawEvent("e-1", "cc-session-abc", "tool.bash")];
    const result = ingestEvents(db, events);
    expect(result.count).toBe(1);

    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'")
      .get() as { state: string };
    expect(row.state).toBe("running");

    // A state.transition event was written into the DB alongside the
    // ingested event.
    const transitions = db
      .query(
        "SELECT payload FROM events WHERE session_id = 's-obs' AND type = 'state.transition'"
      )
      .all() as { payload: string }[];
    expect(transitions).toHaveLength(1);
    const p = JSON.parse(transitions[0]!.payload);
    expect(p.from).toBe("dispatched");
    expect(p.to).toBe("running");
  });

  // F-20 — observed sessions auto-transition `running → completed` on a
  // Stop / SessionEnd hook event. Bounds cycle time so F-18 metrics
  // don't skew (per Echo's PR-#54 review).
  it("auto-transitions observed running → completed on SessionEnd event", () => {
    db.exec(
      `UPDATE agent_task_assignment SET state = 'running' WHERE id = 'ata-1'`
    );
    const events = [makeRawEvent("e-1", "cc-session-abc", "SessionEnd")];
    ingestEvents(db, events);

    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'")
      .get() as { state: string };
    expect(row.state).toBe("completed");
  });

  it("auto-transitions observed running → completed on Stop event", () => {
    db.exec(
      `UPDATE agent_task_assignment SET state = 'running' WHERE id = 'ata-1'`
    );
    const events = [makeRawEvent("e-1", "cc-session-abc", "Stop")];
    ingestEvents(db, events);

    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-1'")
      .get() as { state: string };
    expect(row.state).toBe("completed");
  });

  // F-20 — controlled sessions own their state-machine driving via
  // handleCreateSession; the ingestor must not race those transitions.
  it("does NOT auto-transition controlled sessions", () => {
    // Seed a controlled session alongside the existing observed one.
    db.exec(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
       VALUES ('ata-ctrl', 'a-1', 't-1', 'dispatched')`
    );
    db.exec(
      `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind)
       VALUES ('s-ctrl', 'ata-ctrl', 'cc-session-ctrl', 'local.process.controlled')`
    );

    const events = [
      makeRawEvent("e-1", "cc-session-ctrl", "tool.bash"),
      makeRawEvent("e-2", "cc-session-ctrl", "Stop"),
    ];
    ingestEvents(db, events);

    // State unchanged — ingestor doesn't touch controlled sessions.
    const row = db
      .query("SELECT state FROM agent_task_assignment WHERE id = 'ata-ctrl'")
      .get() as { state: string };
    expect(row.state).toBe("dispatched");
  });
});
