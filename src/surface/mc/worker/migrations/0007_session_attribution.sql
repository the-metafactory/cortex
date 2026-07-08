-- SES-1 / #1709 / decision D-16 — session ATTRIBUTION on the D1 (cloud) snapshot.
--
-- Adds the canonical `attribution_target` field to the deployed D1 `sessions`
-- table so the cloud schema matches the local bun:sqlite schema and the shared
-- canonical source (../../db/canonical-session.ts, CANONICAL_SESSION_COLUMNS):
--   - sessions.attribution_target  (the controlled-vocab target a session's spend
--     rolls up to — a repo / domain, extensible per D-16; NULL ⇒ `unattributed`).
--
-- D-16 (ratified #1679): attribution is a `sessions` COLUMN with a controlled
-- vocabulary seeded from repos/domains — a schema field EXTENDING the ADR-0011
-- canonical row, NOT a naming convention and NOT a parallel table. This keeps the
-- SES-1 cost read model a plain projection/GROUP BY over the existing usage columns
-- (input_tokens/output_tokens/cache_read_tokens/cost_usd) already on the row.
--
-- D-16 HONESTY: the column is nullable TEXT with NO server-side default. Unset ⇒
-- the read model renders `unattributed` — an honest "not yet attributed", NEVER
-- inferred or silently defaulted to a principal or project. The controlled
-- vocabulary is enforced at WRITE time (seeded from repos/domains, extensible), not
-- by a CHECK constraint here — mirroring how `classification` / `substrate` carry
-- controlled values as plain TEXT so the ALTER stays safe on a table with rows and
-- the vocabulary can grow without a schema migration per new value.
--
-- Apply: wrangler d1 execute grove-events --file=./migrations/0007_session_attribution.sql
--   (registry/D1 deploys are principal-hands + `--env production`; file only here.
--    The APPLY is HELD [principal-hands], with CK-4a's 0006 — see #1709 scope.)
--
-- Additive + idempotent-friendly: ADD COLUMN is one-shot (errors if re-applied on a
-- DB that already has the column), the index uses IF NOT EXISTS. Mirrors 0006.
--
-- Scope note: the local SQLite `sessions` table gets this column from ../../db/schema.ts
-- (fresh DBs via CREATE TABLE; existing DBs via the COLUMN_ADD_MIGRATIONS pragma-gated
-- ALTER). SES-1 does NOT touch CK-4a's 0006 — this is a NEW migration in the same lane.

ALTER TABLE sessions ADD COLUMN attribution_target TEXT;

-- The SESSIONS ledger (SES-2) and the spend rollups (SES-3) group by attribution.
CREATE INDEX IF NOT EXISTS idx_sessions_attribution_target ON sessions(attribution_target);

-- Bump the schema_version row (0006 seeded version 3).
INSERT OR IGNORE INTO schema_version (version) VALUES (4);
