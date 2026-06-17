-- O-4a.1 — issuance-request state machine.
--
-- Background
-- ──────────
-- Trust model = human-grant: a verified registration (PoP) creates a PENDING
-- issuance request; a credential leaf package is issued only on an explicit
-- admin grant (O-4a.2). This table is the metadata ledger — NO secrets,
-- NO credentials, NO NSC keys. The nullable `leaf_package` column is the
-- O-4a.2 seam: it stays NULL in this slice and is populated by the next slice.
--
-- Design decisions
-- ─────────────────
-- • Idempotent upsert on (principal_id, peer_pubkey): re-registering a peer
--   returns the existing PENDING row, never duplicates. Unique index enforces
--   the cardinality invariant at the DB layer.
-- • CAS guard: grant/reject transitions are gated on status = 'PENDING' at
--   the SQL level so a concurrent double-grant cannot race to both succeed.
-- • status index: admin list-by-status queries (GET /issuance-requests?status=PENDING)
--   scan only the matching partition, not the full table.
-- • ISO-8601 UTC strings for timestamps (TEXT, same as principals/networks).
-- • `granted_by` nullable: set to admin_pubkey on GRANTED, NULL on PENDING/REJECTED.
-- • `leaf_package` TEXT nullable: JSON blob, populated in O-4a.2.

CREATE TABLE IF NOT EXISTS issuance_requests (
  -- Stable, opaque, URL-safe identifier. Generated as a hex UUID on insert.
  request_id     TEXT    NOT NULL PRIMARY KEY,
  -- The principal requesting the credential.
  principal_id   TEXT    NOT NULL,
  -- Base64 Ed25519 pubkey for the peer stack being onboarded.
  peer_pubkey    TEXT    NOT NULL,
  -- The NATS subject scope the peer is requesting (e.g. `federated.<peer>.>`).
  requested_scope TEXT   NOT NULL,
  -- Lifecycle: PENDING → GRANTED or PENDING → REJECTED. No re-transition.
  status         TEXT    NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'GRANTED', 'REJECTED')),
  -- ISO-8601 UTC creation timestamp.
  created_at     TEXT    NOT NULL,
  -- ISO-8601 UTC; set to created_at on insert, updated on grant/reject.
  updated_at     TEXT    NOT NULL,
  -- Admin pubkey (base64) that approved or rejected this request. NULL while PENDING.
  granted_by     TEXT    ,
  -- O-4a.2 seam: JSON blob of the issued leaf credential package. NULL in O-4a.1.
  leaf_package   TEXT
);

-- Fast lookup for admin list-by-status queries.
CREATE INDEX IF NOT EXISTS idx_issuance_requests_status
  ON issuance_requests (status);

-- Idempotency constraint: one PENDING (or decided) request per (principal, peer).
-- The upsert path in the register hook uses ON CONFLICT(principal_id, peer_pubkey)
-- to return the existing row rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issuance_requests_peer
  ON issuance_requests (principal_id, peer_pubkey);
