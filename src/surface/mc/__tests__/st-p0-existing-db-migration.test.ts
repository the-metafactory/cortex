/**
 * ST-P0 / ADR-0011 — existing pre-P0 DB migration regression.
 *
 * The session-tree canonical columns (`parent_session_id`/`substrate` + the
 * denormalized set) are ADDED to an already-initialised local DB by
 * COLUMN_ADD_MIGRATIONS. This test proves `initDatabase` survives a faithful
 * PRE-P0 sessions table -- the shape the running stacks at
 * ~/.local/share/cortex/mc/<stack>/mission-control.db carry (no
 * parent_session_id/substrate yet).
 *
 * REGRESSION GUARD (review 4473738000 blocker): the two session-tree
 * CREATE INDEX ON sessions(parent_session_id) / (substrate) statements
 * must NOT live in SCHEMA_SQL -- init.ts runs the full SCHEMA_SQL loop BEFORE
 * COLUMN_ADD_MIGRATIONS adds those columns, so on an existing DB they reference
 * columns that do not yet exist (no such column: parent_session_id), and
 * initDatabase aborts so the daemon cannot open its DB. The indices belong in
 * the COLUMN_ADD_MIGRATIONS post[] arrays (which run AFTER the ALTERs and
 * unconditionally, so fresh DBs stay covered too). CI was green only because
 * every other test uses a FRESH DB where the columns exist from CREATE TABLE.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { SCHEMA_SQL } from "../db/schema";
import { initDatabase } from "../db/init";

// The pre-P0 sessions shape: exactly the id..ended_at columns the running
// stacks carry, BEFORE the ST-P0 canonical/session-tree columns were added.
const OLD_SESSIONS = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES agent_task_assignment(id) ON DELETE CASCADE,
  cc_session_id TEXT,
  endpoint_kind TEXT NOT NULL
    CHECK(endpoint_kind IN ('local.process.controlled','local.observed','local.process.autonomous')),
  pid INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
)`;

/**
 * Build a faithful pre-P0 DB: every table from SCHEMA_SQL EXCEPT `sessions`
 * (replaced by its OLD shape), and crucially WITHOUT applying any
 * COLUMN_ADD_MIGRATIONS — so the session-tree columns are genuinely absent,
 * the way an already-running stack's DB is before this PR lands.
 *
 * SCHEMA_SQL index statements that reference the not-yet-existing session
 * columns are the very thing under test — so we run SCHEMA_SQL as-is here only
 * for the OTHER tables. The session-tree indices (if still wrongly in
 * SCHEMA_SQL) are skipped at build time so the seed itself can be constructed;
 * the regression is what happens when `initDatabase` re-runs the FULL SCHEMA_SQL
 * over this old DB.
 */
function buildPreP0Db(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS sessions (")) {
      db.run(OLD_SESSIONS);
      continue;
    }
    // Skip any index that targets the session-tree columns that don't exist on
    // the pre-P0 table — building the seed must not depend on the bug we test.
    if (/ON sessions\s*\(\s*(parent_session_id|substrate)\b/.test(sql)) continue;
    db.run(sql);
  }
  return db;
}

describe("ST-P0 — existing pre-P0 DB session-tree migration", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(p + suffix)) rmSync(p + suffix);
    }
    paths.length = 0;
  });
  function freshPath() {
    const p = join(tmpdir(), `st-p0-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return p;
  }

  it("initDatabase succeeds on a pre-P0 sessions table and backfills the canonical columns", () => {
    const path = freshPath();

    // --- seed: a pre-P0 DB with a real session row under an assignment.
    const old = buildPreP0Db(path);
    old.run(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Echo', 'head')`);
    old.run(
      `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-1', 'A task', 'andreas', 'github', 'open')`
    );
    old.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('x-1', 'a-1', 't-1', 'running')`
    );
    old.run(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES ('s-1', 'x-1', 'local.process.controlled', datetime('now'))`
    );
    // Sanity: the pre-P0 table genuinely lacks the session-tree columns.
    const preCols = old
      .query(`SELECT name FROM pragma_table_info('sessions')`)
      .all() as { name: string }[];
    const preNames = preCols.map((c) => c.name);
    expect(preNames).not.toContain("parent_session_id");
    expect(preNames).not.toContain("substrate");
    old.close();

    // --- reopen via initDatabase → MUST NOT throw `no such column: …`.
    const db = initDatabase(path);

    // Canonical session-tree columns now exist on the migrated table.
    const cols = db
      .query(`SELECT name FROM pragma_table_info('sessions')`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("parent_session_id");
    expect(names).toContain("substrate");
    for (const c of [
      "agent_id",
      "agent_name",
      "principal_id",
      "status",
      "duration_ms",
      "events_count",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cost_usd",
      "classification",
      "data_residency",
      "home_principal",
    ]) {
      expect(names).toContain(c);
    }

    // The existing row survived: substrate backfilled to the NOT NULL default,
    // parent_session_id left NULL (agent-rooted), original data intact.
    const row = db.query(`SELECT * FROM sessions WHERE id='s-1'`).get() as Record<string, unknown>;
    expect(row.substrate).toBe("claude-code");
    expect(row.parent_session_id).toBeNull();
    expect(row.assignment_id).toBe("x-1");

    // The session-tree indices were created (by the COLUMN_ADD_MIGRATIONS post[]).
    const idx = db
      .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'`)
      .all() as { name: string }[];
    const idxNames = idx.map((r) => r.name);
    expect(idxNames).toContain("idx_sessions_parent_session_id");
    expect(idxNames).toContain("idx_sessions_substrate");

    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db.close();
  });

  it("is idempotent — a second init over the migrated DB does not error, columns + indices intact", () => {
    const path = freshPath();
    const old = buildPreP0Db(path);
    old.run(`INSERT INTO agents (id, name, type) VALUES ('a-1', 'Echo', 'head')`);
    old.run(
      `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('t-1', 'A', 'andreas', 'github', 'open')`
    );
    old.run(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('x-1', 'a-1', 't-1', 'running')`
    );
    old.run(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind, started_at) VALUES ('s-1', 'x-1', 'local.observed', datetime('now'))`
    );
    old.close();

    const db1 = initDatabase(path);
    db1.close();
    const db2 = initDatabase(path);
    const names = (db2.query(`SELECT name FROM pragma_table_info('sessions')`).all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("parent_session_id");
    expect(names).toContain("substrate");
    const idxNames = (db2.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'`).all() as { name: string }[]).map((r) => r.name);
    expect(idxNames).toContain("idx_sessions_parent_session_id");
    expect(idxNames).toContain("idx_sessions_substrate");
    expect(db2.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db2.close();
  });

  it("a fresh DB still gets the session-tree columns + indices (post[] runs unconditionally)", () => {
    const path = freshPath();
    const db = initDatabase(path);
    const names = (db.query(`SELECT name FROM pragma_table_info('sessions')`).all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("parent_session_id");
    expect(names).toContain("substrate");
    const idxNames = (db.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'`).all() as { name: string }[]).map((r) => r.name);
    expect(idxNames).toContain("idx_sessions_parent_session_id");
    expect(idxNames).toContain("idx_sessions_substrate");
    db.close();
  });
});
