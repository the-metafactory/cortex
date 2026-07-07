-- CK-4a / #1295 / decision D-8 — cross-stack ORIGIN attribution on the D1 (cloud) snapshot.
--
-- Adds the canonical `origin_stack_id` field to the deployed D1 `sessions` table
-- so the cloud schema matches the local bun:sqlite schema and the shared canonical
-- source (../../db/canonical-session.ts, CANONICAL_SESSION_COLUMNS):
--   - sessions.origin_stack_id  (the stack a session ORIGINATED on; NULL ⇒ own/local-stack origin)
-- plus its lookup index. This is the schema-level origin the cross-stack WORKING
-- aggregation (DashboardSnapshot.workingAggregation) groups by — replacing the
-- workingTileKey React-key namespacing that was never a data model (#1295).
--
-- D-8 adopts a column + backfill that EXTENDS the ADR-0011 canonical row rather
-- than forking a parallel origin table, so the read model stays a plain GROUP BY.
--
-- Apply: wrangler d1 execute grove-events --file=./migrations/0006_session_origin_stack.sql
--   (registry/D1 deploys are principal-hands + `--env production`; file only here.)
--
-- Additive + idempotent-friendly: ADD COLUMN is one-shot (errors if re-applied on a
-- DB that already has the column), the index uses IF NOT EXISTS. Mirrors 0005.
--
-- Scope note: the local SQLite `sessions` table gets this column from ../../db/schema.ts
-- (fresh DBs via CREATE TABLE; existing DBs via the COLUMN_ADD_MIGRATIONS pragma-gated
-- ALTER). Provider-retry (agent_task_assignment.retry_after_ms) is LOCAL-ONLY — D1
-- carries no agent_task_assignment table, so there is deliberately no column for it here.

ALTER TABLE sessions ADD COLUMN origin_stack_id TEXT;

-- Cross-stack aggregation groups WORKING metadata by origin stack.
CREATE INDEX IF NOT EXISTS idx_sessions_origin_stack_id ON sessions(origin_stack_id);

-- Bump the schema_version row (0005 seeded version 2).
INSERT OR IGNORE INTO schema_version (version) VALUES (3);
