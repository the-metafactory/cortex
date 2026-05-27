-- R2b / R2.J — vocabulary migration (cortex#436): operator → principal on the D1 (cloud) snapshot.
--
-- Renames the wire/storage identity columns on the deployed D1 database to match
-- the post-migration schema in ../schema.sql:
--   - sessions.operator_id        → principal_id
--   - github_events.operator_id   → principal_id
--   - usage_snapshots.operator_id → principal_id
--   - sessions.home_operator      → home_principal   (IAW D.5 sovereignty column)
-- and recreates the affected indexes.
--
-- Apply: wrangler d1 execute grove-events --file=./migrations/0004_principal_rename.sql
--
-- Single-cut breaking change — no transition shim (cortex#436 §2/§8). Run once on a
-- deployed D1; RENAME COLUMN errors if already applied.
--
-- Scope note: the local SQLite tables (tasks.operator_id, events with type
-- 'operator.input'/'operator.curation') are created fresh from db/schema.ts and need
-- no migration here — D1 carries no events/tasks tables. The historical
-- 0003_sovereignty.sql DDL is left untouched (it must keep adding home_operator on a
-- fresh D1; this migration then renames it).

ALTER TABLE sessions RENAME COLUMN operator_id TO principal_id;
ALTER TABLE github_events RENAME COLUMN operator_id TO principal_id;
ALTER TABLE usage_snapshots RENAME COLUMN operator_id TO principal_id;
ALTER TABLE sessions RENAME COLUMN home_operator TO home_principal;

DROP INDEX IF EXISTS idx_sessions_operator;
CREATE INDEX IF NOT EXISTS idx_sessions_operator ON sessions(principal_id);

DROP INDEX IF EXISTS idx_github_operator;
CREATE INDEX IF NOT EXISTS idx_github_operator ON github_events(principal_id);

DROP INDEX IF EXISTS idx_sessions_home_operator;
CREATE INDEX IF NOT EXISTS idx_sessions_home_principal ON sessions(home_principal) WHERE home_principal IS NOT NULL;
