import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../surface/mc/db/init";
import { SCHEMA_SQL, REBUILD_MIGRATIONS } from "../../surface/mc/db/schema";
import { ingestLedgerEnvelope } from "../ingest";
import { listVigilEvents, writeVigilTransition } from "../db";
import { ENDED_AT, KEY, ledgerEnvelope } from "./fixtures";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("old attention CHECK widens once, retaining rows, timestamps, indexes and foreign keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-attention-"));
  paths.push(dir);
  const path = join(dir, "mc.db");
  const old = new Database(path, { create: true });
  for (const sql of SCHEMA_SQL) old.run(sql.replace(",'state_change'", ""));
  const envelope = ledgerEnvelope();
  ingestLedgerEnvelope(old, envelope, ENDED_AT, { replay: true });
  const event = writeVigilTransition(old, {
    subject_key: KEY, from_value: null, to_value: "failed", direction: "worse",
    run_id: String(envelope.payload.run_id), occurred_at: ENDED_AT,
  }, ENDED_AT);
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
  expect(() => insertKind(old, "state_change")).toThrow();
  const migration = REBUILD_MIGRATIONS.find((entry) => entry.table === "attention_items")!;
  const tableSql = (db: Database) => db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'attention_items'").get()!.sql;
  expect(migration.detect(tableSql(old))).toBe(true);
  old.close();

  const migrated = initDatabase(path);
  try {
    expect(migrated.query("SELECT * FROM attention_items ORDER BY id").all()).toEqual(before);
    expect(listVigilEvents(migrated, KEY)).toEqual([event]);
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.query("PRAGMA foreign_key_list(attention_items)").all()).toHaveLength(2);
    expect(migrated.query("PRAGMA index_list(attention_items)").all().map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining(["idx_attention_status_severity", "idx_attention_work_item"]));
    expect(migration.detect(tableSql(migrated))).toBe(false);
    expect(() => insertKind(migrated, "state_change")).not.toThrow();
    expect(() => insertKind(migrated, "unknown-kind")).toThrow();
    expect(() => migrated.run("UPDATE attention_items SET severity = 'bogus'")).toThrow();
    expect(() => migrated.run("UPDATE attention_items SET status = 'bogus'")).toThrow();
    expect(() => migrated.run("UPDATE attention_items SET work_item_id = 'missing'")).toThrow();
    expect(migrated.query("PRAGMA table_info(vigil_events)").all().map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining(["severity", "attention_id"]));
  } finally { migrated.close(); }

  const reopened = initDatabase(path);
  try {
    expect(reopened.query("SELECT * FROM attention_items WHERE id LIKE 'old-%' ORDER BY id").all()).toEqual(before);
    expect(migration.detect(tableSql(reopened))).toBe(false);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
});

test("fresh databases retain the kind CHECK", () => {
  const db = initDatabase(":memory:");
  try {
    expect(() => db.run("INSERT INTO attention_items (id, stack_id, kind) VALUES ('valid', 'default', 'state_change')")).not.toThrow();
    expect(() => db.run("INSERT INTO attention_items (id, stack_id, kind) VALUES ('invalid', 'default', 'unknown-kind')")).toThrow();
  } finally { db.close(); }
});
