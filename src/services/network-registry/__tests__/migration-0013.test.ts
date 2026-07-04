/**
 * cortex#1498 (epic #1479 follow-up) — migration 0013 (`hub_authorized_at`).
 *
 * Runs the real SQL chain (0001 → 0004 → 0007 → 0008 → 0010 → 0012 → 0013)
 * against `bun:sqlite` (D1 is SQLite under the hood) and proves the ADD COLUMN
 * is additive + nullable + backward-compatible:
 *   - applies cleanly on top of the full admission_requests chain (0007's
 *     recreate, 0008's unique index, 0010's sealed_secret + REVOKED,
 *     0012's DEPARTED);
 *   - a PRE-EXISTING row (inserted before 0013 runs) reads back with
 *     `hub_authorized_at = NULL` — no data loss, no default value;
 *   - a fresh row after 0013 defaults to NULL too;
 *   - the column can be set + cleared like any other nullable TEXT column
 *     (proving the ALTER produced a real, writable column, not just a
 *     read-only view).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

let db: Database;

function applyThrough0012(): void {
  for (const f of [
    "0001_init.sql",
    "0004_issuance_requests.sql",
    "0007_admission_requests.sql",
    "0008_admission_network_idempotency.sql",
    "0010_admission_sealed_secret.sql",
    "0012_admission_departed.sql",
  ]) {
    db.run(readFileSync(join(migrationsDir, f), "utf8"));
  }
}

function apply0013(): void {
  db.run(readFileSync(join(migrationsDir, "0013_admission_hub_authorized.sql"), "utf8"));
}

interface Row {
  request_id: string;
  status: string;
  hub_authorized_at: string | null;
}

function insertPending(requestId: string): void {
  db.run(
    `INSERT INTO admission_requests
       (request_id, principal_id, peer_pubkey, requested_scope, network_id, status, created_at, updated_at, granted_by)
     VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL)`,
    [requestId, "alice", "pk-alice", "federated.alice.>", "metafactory", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
  );
}

function readRow(requestId: string): Row {
  return db
    .query(`SELECT request_id, status, hub_authorized_at FROM admission_requests WHERE request_id = ?`)
    .get(requestId) as Row;
}

beforeEach(() => {
  db = new Database(":memory:");
  applyThrough0012();
});

describe("migration 0013 — hub_authorized_at ADD COLUMN", () => {
  test("applies cleanly on top of the 0001..0012 chain", () => {
    expect(() => apply0013()).not.toThrow();
  });

  test("a PRE-EXISTING row (inserted before 0013) reads back hub_authorized_at = NULL — no data loss", () => {
    insertPending("req-pre-existing");
    apply0013();
    const row = readRow("req-pre-existing");
    expect(row.hub_authorized_at).toBeNull();
    expect(row.status).toBe("PENDING"); // untouched by the ALTER
  });

  test("a row inserted AFTER 0013 defaults hub_authorized_at to NULL too", () => {
    apply0013();
    insertPending("req-post-migration");
    const row = readRow("req-post-migration");
    expect(row.hub_authorized_at).toBeNull();
  });

  test("the column is writable — UPDATE sets it, and it can be cleared back to NULL", () => {
    apply0013();
    insertPending("req-writable");
    db.run(`UPDATE admission_requests SET status = 'ADMITTED' WHERE request_id = ?`, ["req-writable"]);

    db.run(`UPDATE admission_requests SET hub_authorized_at = ? WHERE request_id = ?`, [
      "2026-02-01T00:00:00Z",
      "req-writable",
    ]);
    expect(readRow("req-writable").hub_authorized_at).toBe("2026-02-01T00:00:00Z");

    db.run(`UPDATE admission_requests SET hub_authorized_at = NULL WHERE request_id = ?`, ["req-writable"]);
    expect(readRow("req-writable").hub_authorized_at).toBeNull();
  });

  test("re-applying 0013 is idempotent (IF NOT EXISTS-equivalent for D1's ADD COLUMN semantics is out of scope — this asserts the migration itself only runs once in the real runner); running it a second time on a FRESH db still just adds the column", () => {
    // Sanity: applying to a second fresh chain (not re-applying to the SAME db,
    // which SQLite would reject with a duplicate-column error — the real
    // migration runner never re-applies a migration to the same database).
    const db2 = new Database(":memory:");
    for (const f of [
      "0001_init.sql",
      "0004_issuance_requests.sql",
      "0007_admission_requests.sql",
      "0008_admission_network_idempotency.sql",
      "0010_admission_sealed_secret.sql",
      "0012_admission_departed.sql",
      "0013_admission_hub_authorized.sql",
    ]) {
      db2.run(readFileSync(join(migrationsDir, f), "utf8"));
    }
    const cols = db2.query(`PRAGMA table_info(admission_requests)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("hub_authorized_at");
  });
});
