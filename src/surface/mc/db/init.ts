/**
 * Grove Mission Control v2 — database initialization.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { COLUMN_ADD_MIGRATIONS, REBUILD_MIGRATIONS, SCHEMA_SQL } from "./schema";

/**
 * Open (or create) a SQLite database at the given path,
 * enable WAL mode, and run all CREATE TABLE statements.
 *
 * Creates parent directories if they don't exist.
 */
export function initDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  for (const sql of SCHEMA_SQL) {
    db.run(sql);
  }

  // F-13 — additive ALTERs guarded against re-application. SQLite has no
  // `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; we read pragma_table_info
  // and skip the DDL when the column is already present. Runs idempotently
  // both on a fresh DB (column absent → ALTER) and on a DB previously
  // initialised by this same code (column present → skip).
  for (const m of COLUMN_ADD_MIGRATIONS) {
    const present = db
      .query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(m.table, m.column);
    if (!present) {
      db.run(m.ddl);
    }
    if (m.post) {
      for (const sql of m.post) db.run(sql);
    }
  }

  // G-1113.D.7c — guarded table-rebuild migrations (drop a CHECK that SQLite
  // can't ALTER away). Runs AFTER the column-adds so the rebuild can copy
  // every current column. Each is idempotent via `detect` (skips once the old
  // shape is gone). FK enforcement is toggled OFF only around the rebuild —
  // the drop/rename would otherwise trip the agent_task_assignment → tasks FK
  // mid-rebuild — and a foreign_key_check verifies integrity before re-enabling.
  for (const rb of REBUILD_MIGRATIONS) {
    const row = db
      .query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(rb.table) as { sql: string } | null;
    if (!row || !rb.detect(row.sql)) continue;

    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.run("BEGIN");
      try {
        for (const sql of rb.steps) db.run(sql);
        // Verify integrity BEFORE committing — a violating rebuild is rolled
        // back, never made durable (prevention, not just detection).
        const violations = db.query("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(
            `D.7c rebuild of '${rb.table}' left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations)}`
          );
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
    } finally {
      // Always restore the connection-level FK enforcement the rest of the app expects.
      db.run("PRAGMA foreign_keys = ON");
    }
  }

  return db;
}
