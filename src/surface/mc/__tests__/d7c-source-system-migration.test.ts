/**
 * G-1113.D.7c — existing-DB rebuild migration for tasks.source_system.
 *
 * Proves the table-rebuild (drop the github|internal CHECK) is DATA-SAFE on an
 * existing DB: it preserves every column (incl. the migrated iteration_id), all
 * rows, and the agent_task_assignment → tasks FK — the PR #120 data-loss class
 * of failure. Builds a faithful pre-D.7c DB (full schema, but the OLD tasks
 * shape with the CHECK), then reopens via initDatabase to trigger the rebuild.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { SCHEMA_SQL, COLUMN_ADD_MIGRATIONS } from "../db/schema";
import { initDatabase } from "../db/init";

// The pre-D.7c tasks shape — base columns WITH the source_system CHECK.
const OLD_TASKS = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  principal_id TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK(source_system IN ('github','internal')),
  source_url TEXT,
  source_external_id TEXT,
  related_refs_json TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','in_progress','done','cancelled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)`;

/** Build a faithful pre-D.7c DB: full schema, but the OLD (CHECK'd) tasks table. */
function buildOldDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) {
    db.run(sql.includes("CREATE TABLE IF NOT EXISTS tasks (") ? OLD_TASKS : sql);
  }
  // Apply the iteration_id column-add exactly as the old code would have.
  for (const m of COLUMN_ADD_MIGRATIONS) {
    const present = db.query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(m.table, m.column);
    if (!present) db.run(m.ddl);
    if (m.post) for (const s of m.post) db.run(s);
  }
  return db;
}

describe("D.7c — tasks.source_system CHECK rebuild migration", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(p + suffix)) rmSync(p + suffix);
    }
    paths.length = 0;
  });
  function freshPath() {
    const p = join(tmpdir(), `d7c-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return p;
  }

  it("preserves rows, iteration_id, and the assignment FK while dropping the CHECK", () => {
    const path = freshPath();

    // --- seed a pre-D.7c DB: an iteration, a github task filed under it, an agent + assignment.
    const old = buildOldDb(path);
    old.run(`INSERT INTO iterations (id, title, state) VALUES ('it-1', 'Iter', 'inbox')`);
    old.run(
      `INSERT INTO tasks (id, title, principal_id, source_system, source_url, source_external_id, status, iteration_id)
       VALUES ('t-1', 'A task', 'andreas', 'github', 'https://github.com/o/r/issues/1', 'o/r#1', 'open', 'it-1')`
    );
    old.run(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Echo', 'head')`);
    old.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('x-1', 'a-1', 't-1', 'queued')`
    );
    // The old CHECK rejects a non-github/internal provider.
    expect(() =>
      old.run(
        `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-bad', 'x', 'andreas', 'gitlab', 'open')`
      )
    ).toThrow();
    old.close();

    // --- reopen via initDatabase → triggers the D.7c rebuild.
    const db = initDatabase(path);

    // CHECK is gone — `tasks` schema no longer carries the source_system CHECK.
    const tasksSql = (db.query(`SELECT sql FROM sqlite_master WHERE name='tasks'`).get() as { sql: string }).sql;
    expect(tasksSql).not.toMatch(/CHECK\s*\(\s*source_system/i);

    // Data preserved exactly — including the migrated iteration_id column.
    const t = db.query(`SELECT * FROM tasks WHERE id='t-1'`).get() as Record<string, unknown>;
    expect(t.source_system).toBe("github");
    expect(t.source_external_id).toBe("o/r#1");
    expect(t.iteration_id).toBe("it-1");

    // The assignment FK survived the drop/rename, and integrity is intact.
    const x = db.query(`SELECT task_id FROM agent_task_assignment WHERE id='x-1'`).get() as { task_id: string };
    expect(x.task_id).toBe("t-1");
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);

    // A provider-neutral source_system now inserts (CHECK relaxed).
    expect(() =>
      db.run(
        `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-gl', 'gl', 'andreas', 'gitlab', 'open')`
      )
    ).not.toThrow();

    // The status CHECK is still enforced (we only dropped the source_system one).
    expect(() =>
      db.run(
        `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-bs', 'x', 'andreas', 'github', 'bogus')`
      )
    ).toThrow();

    // Indexes recreated.
    const idx = db.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'`).all() as { name: string }[];
    const names = idx.map((r) => r.name);
    expect(names).toContain("idx_tasks_status_priority_updated");
    expect(names).toContain("idx_tasks_iteration");
    db.close();
  });

  it("is idempotent — a second init does not re-rebuild or error, data intact", () => {
    const path = freshPath();
    const old = buildOldDb(path);
    old.run(
      `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-1', 'A', 'andreas', 'github', 'open')`
    );
    old.close();

    const db1 = initDatabase(path);
    db1.close();
    // Second open: detect() sees no CHECK → skips the rebuild cleanly.
    const db2 = initDatabase(path);
    expect((db2.query(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(1);
    expect(db2.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db2.close();
  });

  it("rolls back (and leaves the original table intact) if the rebuild would break FK integrity", () => {
    const path = freshPath();
    const old = buildOldDb(path);
    old.run(
      `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-1', 'A', 'andreas', 'github', 'open')`
    );
    old.run(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Echo', 'head')`);
    // Pre-seed an ORPHAN assignment (task_id points at no task) with FK enforcement
    // off — so the post-rebuild foreign_key_check finds a violation and the rebuild
    // must roll back rather than commit.
    old.run("PRAGMA foreign_keys = OFF");
    old.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('x-orphan', 'a-1', 'ghost-task', 'queued')`
    );
    old.close();

    // initDatabase must THROW (the rebuild detected the FK violation pre-COMMIT).
    expect(() => initDatabase(path)).toThrow(/foreign-key violation/i);

    // Rollback proven: the ORIGINAL CHECK'd tasks table is intact, data preserved.
    const raw = new Database(path);
    const tasksSql = (raw.query(`SELECT sql FROM sqlite_master WHERE name='tasks'`).get() as { sql: string }).sql;
    expect(tasksSql).toMatch(/CHECK\s*\(\s*source_system\s+IN/i); // still the old shape
    expect((raw.query(`SELECT COUNT(*) c FROM tasks`).get() as { c: number }).c).toBe(1);
    expect((raw.query(`SELECT title FROM tasks WHERE id='t-1'`).get() as { title: string }).title).toBe("A");
    raw.close();
  });

  it("a fresh DB is born neutral — no CHECK, no rebuild needed", () => {
    const path = freshPath();
    const db = initDatabase(path);
    const tasksSql = (db.query(`SELECT sql FROM sqlite_master WHERE name='tasks'`).get() as { sql: string }).sql;
    expect(tasksSql).not.toMatch(/CHECK\s*\(\s*source_system/i);
    expect(() =>
      db.run(
        `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-1', 'x', 'andreas', 'gitlab', 'open')`
      )
    ).not.toThrow();
    db.close();
  });
});
