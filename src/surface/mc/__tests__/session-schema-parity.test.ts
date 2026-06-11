/**
 * ST-P0 / ADR-0011 — canonical session schema PARITY test (the load-bearing
 * deliverable). Loads the single shared source
 * ({@link CANONICAL_SESSION_COLUMNS}) and asserts BOTH physical schemas —
 * the local bun:sqlite `sessions` DDL in `db/schema.ts` and the cloud D1
 * `sessions` DDL in `worker/schema.sql` — carry every canonical column with the
 * correct PER-SUBSTRATE physical name (`localName` vs `d1Name`).
 *
 * Drift (a canonical column missing from one physical schema, or present under a
 * name the canonical source did not sanction) FAILS CI. This is the structural
 * closure of the recurring schema-divergence bug class (#877/#879) that ADR-0011
 * decision 5 mandates.
 *
 * Column extraction is intentionally string-level (parse the `CREATE TABLE
 * sessions ( … )` body, split on top-level commas, read the leading identifier of
 * each clause). That keeps the test independent of any DDL-builder and catches a
 * hand-edit to either physical schema that silently drops/renames a column.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_SESSION_COLUMNS,
  CANONICAL_SESSION_INDICES,
} from "../db/canonical-session";
import { SCHEMA_SQL, COLUMN_ADD_MIGRATIONS } from "../db/schema";

const MC_DIR = join(import.meta.dir, "..");
const WORKER_SCHEMA = join(MC_DIR, "worker", "schema.sql");

/**
 * Extract the column names declared in a `CREATE TABLE sessions ( … )` body.
 * Splits the parenthesised body on top-level commas, then takes the leading
 * identifier of each clause — skipping table-level CHECK/FK/PRIMARY/UNIQUE
 * clauses that don't begin with a column name.
 */
function extractSessionColumns(createTableSql: string): string[] {
  // Strip `-- …` line comments FIRST — both physical DDLs carry inline comments
  // that contain parens/commas (e.g. `(post-did:mf: strip)`); leaving them in
  // would corrupt the paren-depth + comma split below.
  const noComments = createTableSql
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");

  const open = noComments.indexOf("(");
  const close = noComments.lastIndexOf(")");
  const body = noComments.slice(open + 1, close);

  // Top-level comma split, paren-depth-aware so a `DEFAULT (datetime('now'))`
  // (or any future nested paren) doesn't split a clause.
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      clauses.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) clauses.push(current);

  const TABLE_LEVEL = new Set([
    "CHECK",
    "FOREIGN",
    "PRIMARY",
    "UNIQUE",
    "CONSTRAINT",
  ]);
  const cols: string[] = [];
  for (const clause of clauses) {
    const cleaned = clause.replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const first = cleaned.split(/\s+/)[0];
    if (!first || TABLE_LEVEL.has(first.toUpperCase())) continue;
    cols.push(first);
  }
  return cols;
}

/** The local `sessions` CREATE TABLE statement, pulled from SCHEMA_SQL. */
function localSessionsDdl(): string {
  const ddl = SCHEMA_SQL.find((s) => /CREATE TABLE IF NOT EXISTS sessions\b/.test(s));
  if (!ddl) throw new Error("no `sessions` CREATE TABLE found in db/schema.ts SCHEMA_SQL");
  return ddl;
}

/** The D1 `sessions` CREATE TABLE statement, pulled from worker/schema.sql. */
function d1SessionsDdl(): string {
  const sql = readFileSync(WORKER_SCHEMA, "utf8");
  const m = /CREATE TABLE IF NOT EXISTS sessions\s*\([\s\S]*?\n\);/.exec(sql);
  if (!m) throw new Error("no `sessions` CREATE TABLE found in worker/schema.sql");
  return m[0];
}

describe("canonical session schema parity (ADR-0011)", () => {
  const localCols = new Set(extractSessionColumns(localSessionsDdl()));
  const d1Cols = new Set(extractSessionColumns(d1SessionsDdl()));

  test("local bun:sqlite sessions carries every canonical column under its localName", () => {
    const missing: string[] = [];
    for (const col of CANONICAL_SESSION_COLUMNS) {
      if (!localCols.has(col.localName)) missing.push(col.localName);
    }
    expect(missing, `local sessions DDL missing canonical columns: ${missing.join(", ")}`).toEqual([]);
  });

  test("cloud D1 sessions carries every canonical column under its d1Name", () => {
    const missing: string[] = [];
    for (const col of CANONICAL_SESSION_COLUMNS) {
      if (!d1Cols.has(col.d1Name)) missing.push(col.d1Name);
    }
    expect(missing, `D1 sessions DDL missing canonical columns: ${missing.join(", ")}`).toEqual([]);
  });

  test("the two name-split columns are deliberate Phase-2 renames, not accidental drift", () => {
    const splits = CANONICAL_SESSION_COLUMNS.filter((c) => c.localName !== c.d1Name);
    // Exactly the documented pair: identity (id↔session_id) + terminal (ended_at↔completed_at).
    expect(splits.map((c) => c.d1Name).sort()).toEqual(["completed_at", "session_id"]);
    for (const c of splits) {
      // Each split MUST carry a phase2Rename rationale (the gate that proves it's
      // intended). An undocumented localName!=d1Name would fail here.
      expect(c.phase2Rename, `split column ${c.d1Name} lacks a phase2Rename rationale`).toBeTruthy();
      // And both physical names must actually be present in their own schema.
      expect(localCols.has(c.localName)).toBe(true);
      expect(d1Cols.has(c.d1Name)).toBe(true);
    }
  });

  test("the session-tree fields (parent_session_id, substrate) are present in both", () => {
    for (const name of ["parent_session_id", "substrate"]) {
      expect(localCols.has(name), `local missing ${name}`).toBe(true);
      expect(d1Cols.has(name), `D1 missing ${name}`).toBe(true);
    }
  });

  test("both schemas declare the canonical session indices", () => {
    // The two session-tree indices live in the COLUMN_ADD_MIGRATIONS post[]
    // arrays (NOT in SCHEMA_SQL — see schema.ts: declaring them in SCHEMA_SQL
    // crashes initDatabase on a pre-P0 DB whose columns the SCHEMA_SQL loop
    // precedes). Scan BOTH sources so the canonical-contract assertion still
    // holds after that move.
    const postIndexSql = COLUMN_ADD_MIGRATIONS.flatMap((m) => m.post ?? []).join("\n");
    const localSql = [...SCHEMA_SQL, postIndexSql].join("\n");
    const d1Sql = readFileSync(WORKER_SCHEMA, "utf8");
    for (const idx of CANONICAL_SESSION_INDICES) {
      expect(localSql.includes(idx), `local missing index ${idx}`).toBe(true);
      expect(d1Sql.includes(idx), `D1 missing index ${idx}`).toBe(true);
    }
  });
});

describe("canonical session column substrate-DDL emission", () => {
  test("substrate column is NOT NULL DEFAULT 'claude-code' in both physical schemas", () => {
    const substrate = CANONICAL_SESSION_COLUMNS.find(
      (c) => c.d1Name === "substrate"
    )!;
    expect(substrate.notNull).toBe(true);
    expect(substrate.default).toBe("'claude-code'");

    const localSql = localSessionsDdl();
    const d1Sql = d1SessionsDdl();
    expect(/substrate\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'claude-code'/.test(localSql)).toBe(true);
    // D1 mirrors with NOT NULL DEFAULT too (fresh-DB path); the migration uses a
    // bare DEFAULT for the ALTER (SQLite can't ADD a NOT NULL col without default).
    expect(/substrate\s+TEXT[\s\S]*DEFAULT\s+'claude-code'/.test(d1Sql)).toBe(true);
  });

  test("parent_session_id is nullable TEXT in both physical schemas", () => {
    const parent = CANONICAL_SESSION_COLUMNS.find(
      (c) => c.d1Name === "parent_session_id"
    )!;
    expect(parent.notNull).toBe(false);
    expect(parent.localName).toBe("parent_session_id");
  });
});
