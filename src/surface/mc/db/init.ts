/**
 * Grove Mission Control v2 — database initialization.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { COLUMN_ADD_MIGRATIONS, SCHEMA_SQL } from "./schema";

/**
 * Open (or create) a SQLite database at the given path,
 * enable WAL mode, and run all CREATE TABLE statements.
 *
 * Creates parent directories if they don't exist.
 */
export function initDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  for (const sql of SCHEMA_SQL) {
    db.exec(sql);
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
      db.exec(m.ddl);
    }
    if (m.post) {
      for (const sql of m.post) db.exec(sql);
    }
  }

  return db;
}
