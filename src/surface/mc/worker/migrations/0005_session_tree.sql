-- ST-P0 / ADR-0011 — session-tree convergence on the D1 (cloud) snapshot.
--
-- Adds the two canonical session-tree fields to the deployed D1 `sessions`
-- table so the cloud schema matches the local bun:sqlite schema and the shared
-- canonical source (../../db/canonical-session.ts, CANONICAL_SESSION_COLUMNS):
--   - sessions.parent_session_id  (self-ref to the spawning session; NULL ⇒ agent-rooted)
--   - sessions.substrate          (claude-code | codex | … — an attribute of a session)
-- and the two session-tree indices.
--
-- The cloud `sessions` row was ALREADY flat/denormalized (agent_id, agent_name,
-- principal_id, status, metrics, and the sovereignty columns are columns) — only
-- these two fields were missing, so this migration is purely additive.
--
-- Apply: wrangler d1 execute grove-events --file=./migrations/0005_session_tree.sql
--   (deploy is OUT OF SCOPE for ST-P0 — file only; applied dev→prod in a later phase)
--
-- Additive + idempotent-friendly: ADD COLUMN is one-shot (errors if re-applied on
-- a DB that already has the column), the indices use IF NOT EXISTS. Mirrors the
-- 0003/0004 format.
--
-- Scope note: the local SQLite `sessions` table gets these columns from
-- ../../db/schema.ts (fresh DBs via CREATE TABLE; existing DBs via the
-- COLUMN_ADD_MIGRATIONS pragma-gated ALTERs) and needs no migration here — D1
-- carries no events/tasks/agents tables.

ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
-- SQLite ALTER ADD COLUMN with NOT NULL requires a constant DEFAULT (satisfied).
ALTER TABLE sessions ADD COLUMN substrate TEXT NOT NULL DEFAULT 'claude-code';

-- Session-tree lookups: children of a session, and sessions per substrate.
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_substrate ON sessions(substrate);

-- Bump the schema_version row (schema.sql seeds version 1).
INSERT OR IGNORE INTO schema_version (version) VALUES (2);
