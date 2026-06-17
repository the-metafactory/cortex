/**
 * O-4a.1 — migration 0004 (issuance_requests table) shape test.
 *
 * Runs the real SQL against `bun:sqlite` (D1 is SQLite under the hood).
 * Verifies the table DDL, constraints, and indexes match the spec:
 *   - request_id PRIMARY KEY
 *   - status CHECK IN ('PENDING','GRANTED','REJECTED') with DEFAULT 'PENDING'
 *   - nullable granted_by + leaf_package
 *   - UNIQUE(principal_id, peer_pubkey) — idempotency constraint
 *   - idx_issuance_requests_status index exists
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

let db: Database;

function applyMigrations(): void {
  db.run(readFileSync(join(migrationsDir, "0001_init.sql"), "utf8"));
  db.run(readFileSync(join(migrationsDir, "0004_issuance_requests.sql"), "utf8"));
}

function insertRequest(opts: {
  request_id: string;
  principal_id: string;
  peer_pubkey: string;
  requested_scope?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  granted_by?: string | null;
  leaf_package?: string | null;
}): void {
  const now = "2026-01-01T00:00:00Z";
  db.run(
    `INSERT INTO issuance_requests
       (request_id, principal_id, peer_pubkey, requested_scope, status, created_at, updated_at, granted_by, leaf_package)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.request_id,
      opts.principal_id,
      opts.peer_pubkey,
      opts.requested_scope ?? "federated.peer.>",
      opts.status ?? "PENDING",
      opts.created_at ?? now,
      opts.updated_at ?? now,
      opts.granted_by ?? null,
      opts.leaf_package ?? null,
    ],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations();
});

describe("migration 0004 — issuance_requests table", () => {
  test("inserts a PENDING request with nulls for granted_by and leaf_package", () => {
    insertRequest({ request_id: "req-001", principal_id: "alice", peer_pubkey: "ALICE_PUBKEY".padEnd(44, "A") });
    const row = db
      .query("SELECT * FROM issuance_requests WHERE request_id = ?")
      .get("req-001") as Record<string, unknown>;
    expect(row.status).toBe("PENDING");
    expect(row.granted_by).toBeNull();
    expect(row.leaf_package).toBeNull();
    expect(row.principal_id).toBe("alice");
    expect(row.peer_pubkey).toBe("ALICE_PUBKEY".padEnd(44, "A"));
  });

  test("DEFAULT status is PENDING when not specified", () => {
    db.run(
      `INSERT INTO issuance_requests
         (request_id, principal_id, peer_pubkey, requested_scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["req-default", "bob", "BOB_PUBKEY00".padEnd(44, "B"), "federated.bob.>", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    );
    const row = db
      .query("SELECT status FROM issuance_requests WHERE request_id = ?")
      .get("req-default") as { status: string };
    expect(row.status).toBe("PENDING");
  });

  test("status CHECK constraint rejects invalid values", () => {
    expect(() => {
      insertRequest({ request_id: "req-bad", principal_id: "carol", peer_pubkey: "CAROL_PUBKEY".padEnd(44, "C"), status: "APPROVED" });
    }).toThrow();
  });

  test("UNIQUE(principal_id, peer_pubkey) prevents duplicate rows", () => {
    const pubkey = "DAVE_PUBKEY00".padEnd(44, "D");
    insertRequest({ request_id: "req-d1", principal_id: "dave", peer_pubkey: pubkey });
    expect(() => {
      insertRequest({ request_id: "req-d2", principal_id: "dave", peer_pubkey: pubkey });
    }).toThrow();
  });

  test("request_id is the PRIMARY KEY — duplicate request_id fails", () => {
    insertRequest({ request_id: "req-pk", principal_id: "eve", peer_pubkey: "EVE_PUBKEY000".padEnd(44, "E") });
    expect(() => {
      insertRequest({
        request_id: "req-pk",
        principal_id: "frank",
        peer_pubkey: "FRANK_PUBKEY0".padEnd(44, "F"),
      });
    }).toThrow();
  });

  test("granted_by and leaf_package can be set to non-null values", () => {
    insertRequest({
      request_id: "req-granted",
      principal_id: "grace",
      peer_pubkey: "GRACE_PUBKEY0".padEnd(44, "G"),
      status: "GRANTED",
      granted_by: "ADMIN_PUBKEY0".padEnd(44, "X"),
      leaf_package: JSON.stringify({ token: "test" }),
    });
    const row = db
      .query("SELECT * FROM issuance_requests WHERE request_id = ?")
      .get("req-granted") as Record<string, unknown>;
    expect(row.status).toBe("GRANTED");
    expect(row.granted_by).toBe("ADMIN_PUBKEY0".padEnd(44, "X"));
    expect(row.leaf_package).toBe(JSON.stringify({ token: "test" }));
  });

  test("idx_issuance_requests_status index exists", () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='issuance_requests'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_issuance_requests_status");
  });

  test("idx_issuance_requests_peer unique index exists", () => {
    const rows = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='issuance_requests'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_issuance_requests_peer");
  });

  test("idempotent — applying migration twice is a no-op (CREATE IF NOT EXISTS)", () => {
    // Should not throw.
    db.run(readFileSync(join(migrationsDir, "0004_issuance_requests.sql"), "utf8"));
    const count = (db.query("SELECT COUNT(*) as n FROM issuance_requests").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  test("status transition: UPDATE from PENDING to GRANTED succeeds", () => {
    insertRequest({ request_id: "req-trans", principal_id: "henry", peer_pubkey: "HENRY_PUBKEY0".padEnd(44, "H") });
    db.run(
      "UPDATE issuance_requests SET status = ?, granted_by = ?, updated_at = ? WHERE request_id = ? AND status = 'PENDING'",
      ["GRANTED", "ADMIN_PUBKEY0".padEnd(44, "X"), "2026-01-02T00:00:00Z", "req-trans"],
    );
    const row = db
      .query("SELECT status, granted_by FROM issuance_requests WHERE request_id = ?")
      .get("req-trans") as { status: string; granted_by: string };
    expect(row.status).toBe("GRANTED");
    expect(row.granted_by).toBeDefined();
  });
});
