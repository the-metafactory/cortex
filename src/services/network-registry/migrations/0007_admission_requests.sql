-- ADR-0015 R1 — issuance-request → network-admission gate.
--
-- Background
-- ──────────
-- The O-4a issuance-request state machine was built to gate credential
-- issuance (Model A). ADR-0015 repurposes it as the NETWORK-ADMISSION gate:
-- it gates roster membership, mints NOTHING.
--
-- This migration transforms the existing table:
--   1. Add `network_id` column — the target network for this admission request.
--      Nullable for backward-compat with existing PENDING rows; new inserts
--      MUST supply it (enforced at the application layer).
--   2. Drop `leaf_package` column — the O-4a.2 credential-package seam is
--      retired (Model-A machinery). The grant now gates roster membership only.
--   3. Rename status value GRANTED → ADMITTED (no SQL rename support in
--      SQLite; enforced at the application layer via CHECK constraint update).
--
-- Because SQLite does not support DROP COLUMN directly in all versions
-- supported by D1, and renaming CHECK constraint values requires recreating
-- the table, we recreate the table in a portable way:
--   a. Create the new table `admission_requests` alongside.
--   b. Copy surviving rows (PENDING/GRANTED/REJECTED) — GRANTED becomes ADMITTED.
--   c. Drop the old `issuance_requests` table.
--   d. Drop and recreate the indexes on the new table.
--
-- Safety: additive (the registry is not yet deployed in production at this
-- schema version, per the PR description — safe to recreate rather than ALTER).

-- Step A — new table with updated schema.
CREATE TABLE IF NOT EXISTS admission_requests (
  -- Stable, opaque, URL-safe identifier. Generated as a hex UUID on insert.
  request_id     TEXT    NOT NULL PRIMARY KEY,
  -- The principal requesting admission.
  principal_id   TEXT    NOT NULL,
  -- Base64 Ed25519 pubkey for the peer stack being onboarded.
  peer_pubkey    TEXT    NOT NULL,
  -- The NATS subject scope the peer is requesting (e.g. `federated.<peer>.>`).
  requested_scope TEXT   NOT NULL,
  -- Target network for this admission request. Nullable for rows migrated
  -- from the old table (which had no network context); new inserts supply it.
  network_id     TEXT    ,
  -- Lifecycle: PENDING → ADMITTED or PENDING → REJECTED. No re-transition.
  -- ADMITTED replaces GRANTED (the gate now controls roster membership,
  -- not credential issuance).
  status         TEXT    NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'ADMITTED', 'REJECTED')),
  -- ISO-8601 UTC creation timestamp.
  created_at     TEXT    NOT NULL,
  -- ISO-8601 UTC; set to created_at on insert, updated on grant/reject.
  updated_at     TEXT    NOT NULL,
  -- Admin pubkey (base64) that admitted or rejected this request. NULL while PENDING.
  granted_by     TEXT
);

-- Step B — migrate surviving rows; remap GRANTED → ADMITTED.
INSERT INTO admission_requests
  (request_id, principal_id, peer_pubkey, requested_scope, network_id,
   status, created_at, updated_at, granted_by)
SELECT
  request_id,
  principal_id,
  peer_pubkey,
  requested_scope,
  NULL AS network_id,
  CASE status WHEN 'GRANTED' THEN 'ADMITTED' ELSE status END AS status,
  created_at,
  updated_at,
  granted_by
FROM issuance_requests;

-- Step C — drop old table.
DROP TABLE IF EXISTS issuance_requests;

-- Step D — recreate indexes on the new table.
-- Fast lookup for admin list-by-status queries.
CREATE INDEX IF NOT EXISTS idx_admission_requests_status
  ON admission_requests (status);

-- Idempotency constraint: one PENDING (or decided) request per (principal, peer).
-- The upsert path in the register hook uses ON CONFLICT(principal_id, peer_pubkey)
-- to return the existing row rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admission_requests_peer
  ON admission_requests (principal_id, peer_pubkey);
