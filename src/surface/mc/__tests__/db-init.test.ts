import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { initDatabase } from "../db/init";
import { TABLE_NAMES } from "../db/schema";

describe("initDatabase", () => {
  const tmpDir = join(tmpdir(), `mc-db-test-${Date.now()}`);
  const dbPath = join(tmpDir, "test.db");

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the database file and parent directories", () => {
    const db = initDatabase(dbPath);
    expect(existsSync(dbPath)).toBe(true);
    db.close();
  });

  it("creates all required tables", () => {
    const db = initDatabase(dbPath);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    for (const name of TABLE_NAMES) {
      expect(tableNames).toContain(name);
    }
    db.close();
  });

  it("enables WAL mode", () => {
    const db = initDatabase(dbPath);
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode).toBe("wal");
    db.close();
  });

  it("is idempotent — calling twice does not error", () => {
    const db1 = initDatabase(dbPath);
    db1.close();
    const db2 = initDatabase(dbPath);
    const tables = db2
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("tasks");
    db2.close();
  });

  // Spec NFR: "On database path unwritable: exit with clear error message".
  // Forcing a non-writable parent: place a regular file at the path that
  // would need to become a directory. mkdirSync(parent, recursive: true)
  // then throws ENOTDIR — the error must carry the path so the operator
  // knows what's wrong.
  it("throws when the db path's parent is unwritable, with the path in the message", () => {
    mkdirSync(tmpDir, { recursive: true });
    const blocker = join(tmpDir, "not-a-dir");
    writeFileSync(blocker, ""); // regular file, not a dir
    const badPath = join(blocker, "db.sqlite"); // parent is a file → ENOTDIR

    let err: unknown;
    try {
      initDatabase(badPath);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The underlying syscall error includes the offending path — verify it
    // surfaces so the operator can act.
    expect(String((err as Error).message)).toContain(blocker);
  });
});
