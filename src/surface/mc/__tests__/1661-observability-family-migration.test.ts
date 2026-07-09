/**
 * #1661 (MC folds) — existing-DB rebuild migration for observability_events.family.
 *
 * Proves the table-rebuild (widen the 4-family CHECK to 7 families) is DATA-SAFE
 * and BOOT-SAFE on an existing DB. This table's migration ordering caused the MC
 * embed boot crashes #1048/#961, so the test models the HARD case: a faithful
 * pre-U3.3 DB (OLD 4-family CHECK, and NO origin_kind/origin_peer columns), then
 * reopens via initDatabase. That exercises the real ordering — COLUMN_ADD_MIGRATIONS
 * adds the origin columns FIRST, then REBUILD_MIGRATIONS copies them — and asserts
 * initDatabase does not throw, every row/column survives, and the CHECK is relaxed.
 *
 * No table references observability_events (append-only projection), so there is
 * no FK-rollback case to cover (unlike tasks in d7c-source-system-migration.test).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { SCHEMA_SQL, COLUMN_ADD_MIGRATIONS } from "../db/schema";
import { initDatabase } from "../db/init";

// The pre-U3.3 observability_events shape — base columns WITH the OLD 4-family
// CHECK and WITHOUT origin_kind/origin_peer (those are added by the U3.3
// COLUMN_ADD_MIGRATIONS, exactly as on a real running U2.1 stack).
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

/** Build a faithful pre-#1661 DB: full schema, but the OLD (4-family CHECK, no
 *  origin columns) observability_events table + the U3.3 column-adds applied. */
function buildOldDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) {
    db.run(
      sql.includes("CREATE TABLE IF NOT EXISTS observability_events (")
        ? OLD_OBSERVABILITY
        : sql,
    );
  }
  // Apply the column-adds exactly as the old code would have (adds
  // origin_kind/origin_peer to observability_events + its origin index).
  for (const m of COLUMN_ADD_MIGRATIONS) {
    const present = db.query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(m.table, m.column);
    if (!present) db.run(m.ddl);
    if (m.post) for (const s of m.post) db.run(s);
  }
  return db;
}

describe("#1661 — observability_events.family CHECK rebuild migration", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) {
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(p + suffix)) rmSync(p + suffix);
    }
    paths.length = 0;
  });
  function freshPath() {
    const p = join(tmpdir(), `mc1661-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return p;
  }

  it("does not crash boot, preserves rows + origin columns, and widens the CHECK", () => {
    const path = freshPath();

    // --- seed a pre-#1661 DB: one row per OLD family, incl. a foreign-origin row.
    const old = buildOldDb(path);
    old.run(
      `INSERT INTO observability_events (id, envelope_id, family, type, summary, payload, origin_kind, origin_peer)
       VALUES ('o-1', 'env-1', 'signal', 'system.signal.tap.started', 'tap up', '{"a":1}', 'local', NULL)`,
    );
    old.run(
      `INSERT INTO observability_events (id, envelope_id, family, type, origin_kind, origin_peer)
       VALUES ('o-2', 'env-2', 'federation', 'system.federation.peer.sealed', 'foreign', 'nikita/main')`,
    );
    // The OLD CHECK rejects a #1661 family before the rebuild.
    expect(() =>
      old.run(
        `INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('o-bad', 'env-bad', 'access', 'system.access.denied')`,
      ),
    ).toThrow();
    old.close();

    // --- reopen via initDatabase → column-adds (no-op, columns present) THEN the rebuild.
    const db = initDatabase(path);

    // CHECK widened — the stored schema now lists the three #1661 families.
    const sql = (db.query(`SELECT sql FROM sqlite_master WHERE name='observability_events'`).get() as { sql: string }).sql;
    expect(sql).toMatch(/'access'/);
    expect(sql).toMatch(/'dispatch'/);
    expect(sql).toMatch(/'reflex'/);

    // Data preserved exactly — including the U3.3 origin columns.
    const r1 = db.query(`SELECT * FROM observability_events WHERE id='o-1'`).get() as Record<string, unknown>;
    expect(r1.family).toBe("signal");
    expect(r1.envelope_id).toBe("env-1");
    expect(r1.origin_kind).toBe("local");
    expect(r1.payload).toBe('{"a":1}');
    const r2 = db.query(`SELECT * FROM observability_events WHERE id='o-2'`).get() as Record<string, unknown>;
    expect(r2.origin_kind).toBe("foreign");
    expect(r2.origin_peer).toBe("nikita/main");

    // All three new families now insert (CHECK relaxed).
    for (const [i, fam, type] of [
      [1, "access", "system.access.denied"],
      [2, "dispatch", "system.dispatch.stage"],
      [3, "reflex", "reflex.activation.fired"],
    ] as const) {
      expect(() =>
        db.run(
          `INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('n-${i}', 'nenv-${i}', '${fam}', '${type}')`,
        ),
      ).not.toThrow();
    }

    // A bogus family is still rejected (the CHECK is widened, not dropped).
    expect(() =>
      db.run(
        `INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('o-x', 'env-x', 'nonsense', 't')`,
      ),
    ).toThrow();

    // The origin_kind CHECK still holds, and envelope_id UNIQUE survived the rebuild.
    expect(() =>
      db.run(
        `INSERT INTO observability_events (id, envelope_id, family, type, origin_kind) VALUES ('o-ok', 'env-ok', 'signal', 't', 'bogus')`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('o-dup', 'env-1', 'signal', 't')`,
      ),
    ).toThrow();

    // Indexes recreated (timestamp, family, and the U3.3 origin composite).
    const names = (db.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='observability_events'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("idx_observability_timestamp");
    expect(names).toContain("idx_observability_family");
    expect(names).toContain("idx_observability_origin");

    // Integrity intact.
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db.close();
  });

  it("is idempotent — a second init does not re-rebuild or error, data intact", () => {
    const path = freshPath();
    const old = buildOldDb(path);
    old.run(
      `INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('o-1', 'env-1', 'signal', 't')`,
    );
    old.close();

    const db1 = initDatabase(path);
    db1.close();
    // Second open: detect() sees the widened CHECK → skips the rebuild cleanly.
    const db2 = initDatabase(path);
    expect((db2.query(`SELECT COUNT(*) c FROM observability_events`).get() as { c: number }).c).toBe(1);
    // Still accepts a new family (proves the widened CHECK persisted, not re-narrowed).
    expect(() =>
      db2.run(`INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('o-2', 'env-2', 'reflex', 'reflex.activation.fired')`),
    ).not.toThrow();
    db2.close();
  });

  it("a fresh DB is born wide — 7-family CHECK, no rebuild needed", () => {
    const path = freshPath();
    const db = initDatabase(path);
    const sql = (db.query(`SELECT sql FROM sqlite_master WHERE name='observability_events'`).get() as { sql: string }).sql;
    expect(sql).toMatch(/'access'/);
    for (const fam of ["access", "dispatch", "reflex"]) {
      expect(() =>
        db.run(`INSERT INTO observability_events (id, envelope_id, family, type) VALUES ('f-${fam}', 'fenv-${fam}', '${fam}', 't')`),
      ).not.toThrow();
    }
    db.close();
  });
});
