/**
 * P-14 U3.3 (#937) — existing pre-U3.3 observability DB migration regression.
 *
 * The origin-badge columns (`origin_kind` / `origin_peer`) are ADDED to an
 * already-initialised local DB by COLUMN_ADD_MIGRATIONS. This test proves
 * `initDatabase` survives a faithful PRE-U3.3 `observability_events` table --
 * the shape the running U2.1 stacks carry (no origin_kind/origin_peer yet).
 *
 * REGRESSION GUARD (#1048, the #961/ST-P0 bug class reintroduced by U3.3): the
 * `CREATE INDEX idx_observability_origin ON observability_events(origin_kind,
 * origin_peer)` statement must NOT live in SCHEMA_SQL -- init.ts runs the full
 * SCHEMA_SQL loop BEFORE COLUMN_ADD_MIGRATIONS adds those columns, so on an
 * existing DB it references columns that do not yet exist (`no such column:
 * origin_kind`), and initDatabase aborts so the MC embed cannot open its DB
 * ("Mission Control embed startup error (non-fatal): no such column:
 * origin_kind"). The index belongs ONLY in the COLUMN_ADD_MIGRATIONS post[]
 * arrays (which run AFTER the ALTERs and unconditionally, so fresh DBs stay
 * covered too). CI was green only because every other test uses a FRESH DB
 * where the columns exist from CREATE TABLE.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { SCHEMA_SQL } from "../db/schema";
import { initDatabase } from "../db/init";

// The pre-U3.3 observability_events shape: exactly the U2.1 columns the running
// stacks carry, BEFORE the U3.3 origin-badge columns were added. Mirrors the
// observability_events CREATE TABLE in SCHEMA_SQL minus origin_kind/origin_peer.
const OLD_OBSERVABILITY = `CREATE TABLE IF NOT EXISTS observability_events (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL
    CHECK(family IN ('signal','collector','federation','transport')),
  type TEXT NOT NULL,
  stack_id TEXT,
  summary TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/**
 * Build a faithful pre-U3.3 DB: every table from SCHEMA_SQL EXCEPT
 * `observability_events` (replaced by its OLD shape), and crucially WITHOUT
 * applying any COLUMN_ADD_MIGRATIONS — so the origin-badge columns are
 * genuinely absent, the way an already-running U2.1 stack's DB is before this
 * PR lands.
 *
 * The SCHEMA_SQL index statement that references the not-yet-existing origin
 * columns is the very thing under test — so when building the seed we skip any
 * index that targets origin_kind/origin_peer (if it is still wrongly in
 * SCHEMA_SQL); the regression is what happens when `initDatabase` re-runs the
 * FULL SCHEMA_SQL over this old DB.
 */
function buildPreU33Db(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS observability_events (")) {
      db.run(OLD_OBSERVABILITY);
      continue;
    }
    // Skip any index that targets the origin-badge columns that don't exist on
    // the pre-U3.3 table — building the seed must not depend on the bug we test.
    if (/ON observability_events\s*\(\s*(origin_kind|origin_peer)\b/.test(sql)) continue;
    db.run(sql);
  }
  return db;
}

describe("U3.3 — existing pre-U3.3 observability DB origin-badge migration (#1048)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(p + suffix)) rmSync(p + suffix);
    }
    paths.length = 0;
  });
  function freshPath() {
    const p = join(tmpdir(), `u3-3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return p;
  }

  it("initDatabase succeeds on a pre-U3.3 observability table and backfills origin columns + index", () => {
    const path = freshPath();

    // --- seed: a pre-U3.3 DB with a real observability row.
    const old = buildPreU33Db(path);
    old.run(
      `INSERT INTO observability_events (id, envelope_id, family, type, summary)
       VALUES ('o-1', 'env-1', 'signal', 'system.signal.heartbeat', 'heartbeat')`
    );
    // Sanity: the pre-U3.3 table genuinely lacks the origin-badge columns.
    const preNames = (old
      .query(`SELECT name FROM pragma_table_info('observability_events')`)
      .all() as { name: string }[]).map((c) => c.name);
    expect(preNames).not.toContain("origin_kind");
    expect(preNames).not.toContain("origin_peer");
    old.close();

    // --- reopen via initDatabase → MUST NOT throw `no such column: origin_kind`.
    const db = initDatabase(path);

    // Origin-badge columns now exist on the migrated table.
    const names = (db
      .query(`SELECT name FROM pragma_table_info('observability_events')`)
      .all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("origin_kind");
    expect(names).toContain("origin_peer");

    // The existing row survived: origin_kind backfilled to the NOT NULL default
    // ('local' — its true origin: U2.1 only ever folded local rows),
    // origin_peer left NULL, original data intact.
    const row = db
      .query(`SELECT * FROM observability_events WHERE id='o-1'`)
      .get() as Record<string, unknown>;
    expect(row.origin_kind).toBe("local");
    expect(row.origin_peer).toBeNull();
    expect(row.family).toBe("signal");
    expect(row.envelope_id).toBe("env-1");

    // The origin index was created (by the COLUMN_ADD_MIGRATIONS post[]).
    const idxNames = (db
      .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observability_events'`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(idxNames).toContain("idx_observability_origin");

    db.close();
  });

  it("is idempotent — a second init over the migrated DB does not error, columns + index intact", () => {
    const path = freshPath();
    const old = buildPreU33Db(path);
    old.run(
      `INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('o-1', 'env-1', 'transport', 'system.transport.up')`
    );
    old.close();

    const db1 = initDatabase(path);
    db1.close();
    const db2 = initDatabase(path);
    const names = (db2
      .query(`SELECT name FROM pragma_table_info('observability_events')`)
      .all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("origin_kind");
    expect(names).toContain("origin_peer");
    const idxNames = (db2
      .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observability_events'`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(idxNames).toContain("idx_observability_origin");
    db2.close();
  });

  it("a fresh DB still gets the origin columns + index (post[] runs unconditionally)", () => {
    const path = freshPath();
    const db = initDatabase(path);
    const names = (db
      .query(`SELECT name FROM pragma_table_info('observability_events')`)
      .all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain("origin_kind");
    expect(names).toContain("origin_peer");
    const idxNames = (db
      .query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observability_events'`)
      .all() as { name: string }[]).map((r) => r.name);
    expect(idxNames).toContain("idx_observability_origin");
    db.close();
  });
});
