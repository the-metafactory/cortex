-- C-1350 Slice 1 (#1350) — member self-depart: ADMITTED → DEPARTED.
--
-- Background
-- ──────────
-- A member leaving a network voluntarily is DISTINCT from an admin revoking them
-- (ADR-0018 Q6 / migration 0010's REVOKED). `REVOKED` = the hub-admin kicked the
-- member (involuntary); `DEPARTED` = the member left of their own accord. Keeping
-- the two separable preserves the audit distinction ("left" vs "kicked") and lets
-- the admin queue filter departed-but-not-hub-revoked rows (their cue to run
-- `secret revoke-member` and cut the hub `authorization` user).
--
-- Like migration 0010's REVOKED add, DEPARTED must join the status CHECK. SQLite
-- cannot add a value to a CHECK constraint (nor portably DROP a column across all
-- D1-supported versions), so we recreate the table — the SAME portable pattern
-- migrations 0007 and 0010 used — preserving every column 0007/0008/0010
-- established (incl. `sealed_secret`), widening the status CHECK to add
-- 'DEPARTED', copying surviving rows, and recreating BOTH indexes (the status
-- index AND the 0008 per-network COALESCE unique index).
--
-- Roster: NO change needed. `rosterFromAdmissions()` filters `status='ADMITTED'`,
-- so a DEPARTED row auto-drops from `members[]`/roster — the same mechanism a
-- REVOKED row uses.
--
-- Deploy ordering: migration-first. This 0012 recreate MUST be applied before the
-- Worker carrying the `/depart` route + widened `DEPARTED` status enum is
-- deployed, so a DEPARTED write can never hit the pre-0012 CHECK (which would
-- reject it). The prod deploy of both is a HELD principal checkpoint.

-- Step A — new table: 0007/0008/0010 columns + widened status CHECK (+DEPARTED).
CREATE TABLE IF NOT EXISTS admission_requests_v3 (
  request_id      TEXT    NOT NULL PRIMARY KEY,
  principal_id    TEXT    NOT NULL,
  peer_pubkey     TEXT    NOT NULL,
  requested_scope TEXT    NOT NULL,
  network_id      TEXT    ,
  status          TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'ADMITTED', 'REJECTED', 'REVOKED', 'DEPARTED')),
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  granted_by      TEXT    ,
  -- ADR-0018 Q1 (b′) — opaque per-member sealed ciphertext. The registry never
  -- reads it. NULL until add-member (sealed) delivers it; NULL again on
  -- revoke OR depart (a departed member must not retain a fetchable blob).
  sealed_secret   TEXT
);

-- Step B — copy every surviving row unchanged (all existing statuses preserved).
INSERT INTO admission_requests_v3
  (request_id, principal_id, peer_pubkey, requested_scope, network_id,
   status, created_at, updated_at, granted_by, sealed_secret)
SELECT
  request_id, principal_id, peer_pubkey, requested_scope, network_id,
  status, created_at, updated_at, granted_by, sealed_secret
FROM admission_requests;

-- Step C — swap the table in.
DROP TABLE IF EXISTS admission_requests;
ALTER TABLE admission_requests_v3 RENAME TO admission_requests;

-- Step D — recreate indexes (status + the 0008 per-network COALESCE unique).
CREATE INDEX IF NOT EXISTS idx_admission_requests_status
  ON admission_requests (status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admission_requests_peer_network
  ON admission_requests (principal_id, peer_pubkey, COALESCE(network_id, ''));
