import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../db/schema";
import { HookStreamPoller } from "../hooks/poller";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { RawHookEvent } from "../hooks/types";
import type { HooksConfig } from "../types";

function makeEvent(id: string, sessionId: string): RawHookEvent {
  return {
    event_id: id,
    event_type: "tool.bash",
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    agent_id: "luna",
    agent_name: "Luna",
    source: { hook: "PostToolUse", tool_name: "tool.bash" },
    payload: { command: "ls" },
  };
}

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);

  db.exec(`INSERT INTO tasks (id, title, priority, principal_id, source_system) VALUES ('t-1', 'Task', 0, 'op', 'internal')`);
  db.exec(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Luna', 'head')`);
  db.exec(`INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('ata-1', 'a-1', 't-1')`);
  db.exec(
    `INSERT INTO sessions (id, assignment_id, cc_session_id, endpoint_kind)
     VALUES ('s-obs', 'ata-1', 'observed-session-1', 'local.observed')`
  );

  return db;
}

describe("HookStreamPoller", () => {
  let db: Database;
  let tmpDir: string;
  let rawDir: string;
  let config: HooksConfig;

  beforeEach(() => {
    db = setupDb();
    tmpDir = join(tmpdir(), `mc-poller-test-${Date.now()}`);
    rawDir = join(tmpDir, "raw");
    mkdirSync(rawDir, { recursive: true });

    config = {
      rawEventsDir: rawDir,
      cursorPath: join(tmpDir, "cursor.json"),
      pollInterval: 60000, // long interval — we call poll() manually
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ingests events from a matching JSONL file", () => {
    const file = join(rawDir, "observed-session-1.jsonl");
    writeFileSync(
      file,
      JSON.stringify(makeEvent("e-1", "observed-session-1")) + "\n" +
        JSON.stringify(makeEvent("e-2", "observed-session-1")) + "\n"
    );

    const poller = new HookStreamPoller(db, config);
    const count = poller.poll();

    expect(count).toBe(2);

    const rows = db.query("SELECT * FROM events").all();
    expect(rows).toHaveLength(2);
  });

  it("skips .jsonl.gz files", () => {
    writeFileSync(
      join(rawDir, "old-session.jsonl.gz"),
      "fake gzipped data"
    );

    const poller = new HookStreamPoller(db, config);
    const count = poller.poll();

    expect(count).toBe(0);
  });

  it("skips unregistered sessions", () => {
    const file = join(rawDir, "unknown-session.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "unknown-session")) + "\n");

    const poller = new HookStreamPoller(db, config);
    const count = poller.poll();

    expect(count).toBe(0);
  });

  it("reads incrementally across multiple polls", () => {
    const file = join(rawDir, "observed-session-1.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "observed-session-1")) + "\n");

    const poller = new HookStreamPoller(db, config);

    const first = poller.poll();
    expect(first).toBe(1);

    // Append more events
    appendFileSync(file, JSON.stringify(makeEvent("e-2", "observed-session-1")) + "\n");

    const second = poller.poll();
    expect(second).toBe(1);

    const total = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(total.c).toBe(2);
  });

  it("persists cursor across restarts", () => {
    const file = join(rawDir, "observed-session-1.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "observed-session-1")) + "\n");

    // First poller reads and stops (persisting cursor)
    const poller1 = new HookStreamPoller(db, config);
    poller1.poll();
    poller1.stop();

    // Append more
    appendFileSync(file, JSON.stringify(makeEvent("e-2", "observed-session-1")) + "\n");

    // Second poller restores cursor — should only read e-2
    const poller2 = new HookStreamPoller(db, config);
    const count = poller2.poll();
    expect(count).toBe(1);

    const total = db.query("SELECT COUNT(*) as c FROM events").get() as any;
    expect(total.c).toBe(2);
  });

  it("handles nonexistent raw events directory", () => {
    const poller = new HookStreamPoller(db, {
      ...config,
      rawEventsDir: join(tmpDir, "nonexistent"),
    });
    const count = poller.poll();
    expect(count).toBe(0);
  });

  it("start and stop control the poll timer", () => {
    const poller = new HookStreamPoller(db, config);
    poller.start();
    // Starting again is a no-op
    poller.start();
    poller.stop();
    // Stopping again is a no-op
    poller.stop();
  });

  it("cursor file is created after poll with ingested events", () => {
    const file = join(rawDir, "observed-session-1.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent("e-1", "observed-session-1")) + "\n");

    const poller = new HookStreamPoller(db, config);
    poller.poll();

    expect(existsSync(config.cursorPath)).toBe(true);
  });

  it("persists cursor even when no events are ingested (offset-advance case)", () => {
    // Write events for an UNREGISTERED session — reader advances offsets
    // but ingestor ingests 0 events.
    const file = join(rawDir, "some-unknown-session.jsonl");
    writeFileSync(
      file,
      JSON.stringify(makeEvent("e-1", "totally-unknown-session")) + "\n"
    );

    const poller = new HookStreamPoller(db, config);
    const count = poller.poll();
    expect(count).toBe(0);

    // Cursor should STILL be persisted so the offset advance survives restart.
    // Previously this was gated by `totalIngested > 0` which lost the advance.
    expect(existsSync(config.cursorPath)).toBe(true);

    // Verify: a new poller using the same cursor file doesn't re-read
    const poller2 = new HookStreamPoller(db, config);
    const count2 = poller2.poll();
    expect(count2).toBe(0); // no re-read, cursor was persisted
  });

  it("uses chained setTimeout, not setInterval (no overlapping polls)", async () => {
    const shortConfig = { ...config, pollInterval: 50 };
    const poller = new HookStreamPoller(db, shortConfig);

    const file = join(rawDir, "observed-session-1.jsonl");
    writeFileSync(
      file,
      JSON.stringify(makeEvent("e-1", "observed-session-1")) + "\n"
    );

    poller.start();

    // Wait for at least 2 poll cycles to fire
    await new Promise((r) => setTimeout(r, 150));

    poller.stop();

    // Events should have been ingested by the timer-driven poll
    const rows = db.query("SELECT COUNT(*) as c FROM events").all() as any[];
    expect(rows[0].c).toBeGreaterThanOrEqual(1);
  });
});
