import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { SCHEMA_SQL, REBUILD_MIGRATIONS } from "../../surface/mc/db/schema";
import { ingestLedgerEnvelope } from "../ingest";
import { listVigilEvents, type VigilEventRow } from "../db";
import { DELIVERY_DEFAULTS, ENDED_AT, KEY, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

test.each([false, true])("old attention CHECK (state_change=%s) widens once, retaining rows, timestamps, indexes and foreign keys", (hasStateChange) => {
  using file = temporaryVigilDatabaseFile("vigil-attention-");
  const { path } = file;
  const old = new Database(path, { create: true });
  for (const sql of SCHEMA_SQL) {
    const previous = sql.replace(",'proposal'", "")
      .replace(/\s+resolution TEXT\s+CHECK\(resolution IN \([^)]+\)\),/, "");
    old.run(hasStateChange ? previous : previous.replace(",'state_change'", ""));
  }
  const envelope = ledgerEnvelope();
  ingestLedgerEnvelope(old, envelope, ENDED_AT, { replay: true });
  const event: VigilEventRow = {
    id: crypto.randomUUID(), event_kind: "transition", created_at: ENDED_AT,
    severity: null, attention_id: null, route: null, delivery: "pending",
    ...DELIVERY_DEFAULTS,
    subject_key: KEY, from_value: null, to_value: "failed", direction: "worse",
    run_id: String(envelope.payload.run_id), occurred_at: ENDED_AT,
  };
  old.query(`INSERT INTO vigil_events
    (id, subject_key, event_kind, from_value, to_value, direction, run_id, occurred_at, created_at)
    VALUES (?, ?, 'transition', NULL, 'failed', 'worse', ?, ?, ?)`).run(
    event.id, event.subject_key, event.run_id, event.occurred_at, event.created_at,
  );
  old.run("INSERT INTO work_items (id, title, status, provider) VALUES ('work', 'Work', 'open', 'internal')");
  old.run("INSERT INTO agents (id, name, type) VALUES ('agent', 'Agent', 'head')");
  old.run("INSERT INTO tasks (id, title, principal_id, source_system) VALUES ('task', 'Task', 'principal', 'internal')");
  old.run("INSERT INTO agent_task_assignment (id, agent_id, task_id) VALUES ('assignment', 'agent', 'task')");
  old.run("INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('session', 'assignment', 'local.observed')");
  for (const [index, status] of ["open", "resolved", "dismissed"].entries()) {
    old.query(`INSERT INTO attention_items
      (id, stack_id, work_item_id, session_id, kind, severity, status, created_at, updated_at)
      VALUES (?, 'default', 'work', 'session', 'blocked', 'high', ?, 123, 456)`).run(`old-${index}`, status);
  }
  const before = old.query("SELECT * FROM attention_items ORDER BY id").all();
  const insertKind = (db: Database, kind: string) => db.query("INSERT INTO attention_items (id, stack_id, kind) VALUES (?, 'default', ?)").run(kind, kind);
  expect(() => insertKind(old, "proposal")).toThrow();
  expect(old.query("PRAGMA table_info(attention_items)").all().map((row) => (row as { name: string }).name)).not.toContain("resolution");
  const migration = REBUILD_MIGRATIONS.find((entry) => entry.table === "attention_items")!;
  const tableSql = (db: Database) => db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'attention_items'").get()!.sql;
  expect(migration.detect(tableSql(old))).toBe(true);
  old.close();

  const migrated = initDatabase(path);
  const schemaVersion = migrated.query("PRAGMA schema_version").get();
  try {
    expect(migrated.query("SELECT * FROM attention_items ORDER BY id").all()).toEqual(before.map((row) => ({ ...row as object, resolution: null })));
    expect(listVigilEvents(migrated, KEY)).toEqual([event]);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.query("PRAGMA foreign_key_list(attention_items)").all()).toHaveLength(2);
    expect(migrated.query("PRAGMA index_list(attention_items)").all().map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining(["idx_attention_status_severity", "idx_attention_work_item"]));
    expect(migration.detect(tableSql(migrated))).toBe(false);
    expect(() => insertKind(migrated, "state_change")).not.toThrow();
    expect(() => insertKind(migrated, "proposal")).not.toThrow();
    expect(() => insertKind(migrated, "unknown-kind")).toThrow();
    expect(() => migrated.run("UPDATE attention_items SET severity = 'bogus'")).toThrow();
    expect(() => migrated.run("UPDATE attention_items SET status = 'bogus'")).toThrow();
    expect(() => migrated.run("UPDATE attention_items SET work_item_id = 'missing'")).toThrow();
    expect(() => migrated.run("INSERT INTO attention_items (id, stack_id, kind, resolution) VALUES ('bad-resolution', 'default', 'proposal', 'bogus')")).toThrow();
    migrated.run("UPDATE attention_items SET status = 'resolved', resolution = 'approved' WHERE id = 'proposal'");
    expect(migrated.query("PRAGMA table_info(vigil_events)").all().map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining(["severity", "attention_id"]));
  } finally { migrated.close(); }

  const reopened = initDatabase(path);
  try {
    expect(reopened.query("SELECT * FROM attention_items WHERE id LIKE 'old-%' ORDER BY id").all()).toEqual(before.map((row) => ({ ...row as object, resolution: null })));
    expect(reopened.query("SELECT status, resolution FROM attention_items WHERE id = 'proposal'").get()).toEqual({ status: "resolved", resolution: "approved" });
    expect(migration.detect(tableSql(reopened))).toBe(false);
    expect(reopened.query("PRAGMA schema_version").get()).toEqual(schemaVersion);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
});

test("fresh databases accept proposal and all six resolutions with CHECK constraints", () => {
  using file = temporaryVigilDatabaseFile("attention-proposal-");
  const db = initDatabase(file.path);
  try {
    expect(() => db.run("INSERT INTO attention_items (id, stack_id, kind) VALUES ('valid', 'default', 'state_change')")).not.toThrow();
    expect(() => db.run("INSERT INTO attention_items (id, stack_id, kind) VALUES ('invalid', 'default', 'unknown-kind')")).toThrow();
    const insert = db.query("INSERT INTO attention_items (id, stack_id, kind, status, resolution) VALUES (?, 'default', 'proposal', 'resolved', ?)");
    for (const resolution of ["approved", "dismissed", "expired", "superseded", "read", "archived"]) {
      expect(() => insert.run(resolution, resolution)).not.toThrow();
    }
    expect(() => insert.run("invalid-resolution", "bogus")).toThrow();
    expect(db.query("SELECT resolution FROM attention_items WHERE id = 'valid'").get()).toEqual({ resolution: null });
  } finally { db.close(); }
});

test("route and delivery migrate once, preserving historical events without a sendable route", () => {
  using file = temporaryVigilDatabaseFile("vigil-routing-");
  const { path } = file;
  const old = initDatabase(path);
  ingestLedgerEnvelope(old, ledgerEnvelope(), ENDED_AT);
  old.run("ALTER TABLE vigil_events DROP COLUMN route");
  old.run("ALTER TABLE vigil_events DROP COLUMN delivery");
  const historical = old.query<Omit<VigilEventRow, "route" | "delivery">, []>("SELECT * FROM vigil_events").all();
  const subjects = old.query("SELECT * FROM vigil_subjects").all();
  old.close();

  const migrated = initDatabase(path);
  let events;
  try {
    events = listVigilEvents(migrated, KEY);
    expect(events).toEqual(historical.map((event) => ({ ...event, route: null, delivery: "pending" })));
    expect(migrated.query("SELECT * FROM vigil_subjects").all()).toEqual(subjects);
    expect(migrated.query("SELECT * FROM vigil_events WHERE route IS NOT NULL AND delivery = 'pending'").all()).toEqual([]);
    expect(() => migrated.run("UPDATE vigil_events SET route = 'dashboard'")).toThrow();
    expect(() => migrated.run("UPDATE vigil_events SET delivery = 'unknown'")).toThrow();
    expect(() => migrated.run("UPDATE vigil_events SET delivery = NULL")).toThrow();
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { migrated.close(); }

  const reopened = initDatabase(path);
  try {
    expect(listVigilEvents(reopened, KEY)).toEqual(events);
    ingestLedgerEnvelope(reopened, ledgerEnvelope({ outcome: "succeeded", ended_at: "2026-10-12T10:01:05Z" }), ENDED_AT + 60_000);
    expect(listVigilEvents(reopened, KEY)[1]).toMatchObject({ route: "digest", delivery: "pending" });
  } finally { reopened.close(); }
});
