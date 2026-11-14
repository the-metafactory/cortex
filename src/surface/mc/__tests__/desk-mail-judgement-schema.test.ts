import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../db/init";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const open = (path: string): Database => {
  const db = initDatabase(path);
  databases.push(db);
  return db;
};
const listToken = (db: Database): string | undefined => db.query<{ token: string }, []>("SELECT token FROM desk_mail_judgement_list_versions WHERE address = 'sender@example.org'").get()?.token;

test("Mail initialization installs judgement versions and indexed operation lookup before a store exists", () => {
  const db = open(":memory:");
  db.run("INSERT INTO desk_unimportant VALUES ('sender@example.org', 'Example sender', 1)");
  const inserted = listToken(db);
  expect(inserted).toBeString();
  db.run("UPDATE desk_unimportant SET label = 'Edited' WHERE address = 'sender@example.org'");
  expect(listToken(db)).not.toBe(inserted);
  db.run("DELETE FROM desk_unimportant WHERE address = 'sender@example.org'");
  expect(listToken(db)).toBeUndefined();
  const plan = db.query<{ detail: string }, [string]>("EXPLAIN QUERY PLAN UPDATE desk_mail_judgement_operations SET undo_operation = NULL WHERE undo_operation = ? AND undone = 0").all("example");
  expect(plan.some(row => row.detail.includes("desk_mail_judgement_undo_operation"))).toBe(true);
});

test("an existing Mail judgement database gains retention timestamps without changing its evidence or versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-judgement-migration-"));
  directories.push(dir);
  const path = join(dir, "mail.sqlite");
  const prior = new Database(path, { create: true });
  prior.run("CREATE TABLE desk_unimportant (address TEXT PRIMARY KEY, label TEXT, added_at INTEGER NOT NULL)");
  prior.run("INSERT INTO desk_unimportant VALUES ('sender@example.org', 'Example sender', 1)");
  prior.run("CREATE TABLE desk_mail_judgement_operations (operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, request_id TEXT NOT NULL, scope TEXT NOT NULL, message_id TEXT NOT NULL, mail_json TEXT, change_json TEXT, result_json TEXT, undone INTEGER NOT NULL DEFAULT 0, undo_operation TEXT)");
  const at = "2026-11-01T00:00:00.000Z";
  const evidence = JSON.stringify({ kind: "succeeded", evidence: { observedAt: at } });
  prior.query("INSERT INTO desk_mail_judgement_operations (operation_id, digest, request_id, scope, message_id, result_json) VALUES (?, ?, ?, ?, ?, ?)").run("old-operation", "old-digest", "old-request", "old-scope", "message-example", evidence);
  prior.close();
  const db = open(path);
  const token = listToken(db);
  expect(token).toBeString();
  const row = db.query<{ result_json: string; created_at: number }, []>("SELECT result_json, created_at FROM desk_mail_judgement_operations").get();
  expect(row).toEqual({ result_json: evidence, created_at: Date.parse(at) });
  const reopened = open(path);
  expect(listToken(reopened)).toBe(token);
  expect(reopened.query("SELECT result_json, created_at FROM desk_mail_judgement_operations").get()).toEqual(row);
});
