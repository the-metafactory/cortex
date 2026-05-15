-- IAW D.5 — add sovereignty columns to sessions for multi-operator dashboard slicing.
--
-- Apply: wrangler d1 execute grove-events --file=./migrations/0003_sovereignty.sql
--
-- Background: cortex#116 (IAW Phase D — federation) lands the surface-router
-- gate on federated.{operator}.{stack}.> subjects. The cloud dashboard is the
-- multi-operator surface where this traffic surfaces; per the IAW plan §5
-- D.5.2 the dashboard slices on `principal.home_operator` and per D.5.3
-- renders sovereignty + classification on every activity card.
--
-- The ingest pipeline (cortex-relay → cloud-publisher → /api/ingest) hoists
-- `envelope.sovereignty.classification`, `envelope.sovereignty.data_residency`,
-- and `signed_by[0].principal` (operator segment after `did:mf:` strip) onto
-- the event payload when the originating event was minted from a myelin
-- envelope. Pre-IAW publishers omit these fields and the columns stay NULL.
--
-- All three columns are nullable and additive — pre-existing rows keep
-- behaving exactly as today; new rows pick up sovereignty when present.

ALTER TABLE sessions ADD COLUMN classification TEXT;        -- 'local' | 'federated' | 'public' | NULL
ALTER TABLE sessions ADD COLUMN data_residency TEXT;        -- e.g. 'nz', 'eu', NULL
ALTER TABLE sessions ADD COLUMN home_operator TEXT;         -- principal.home_operator (post-`did:mf:` strip)

-- Index `home_operator` because the dashboard filter chip slices the snapshot
-- by it on every poll (D.5.2). Index is partial (NULL excluded) to keep it
-- small — pre-IAW rows never hit this lookup.
CREATE INDEX IF NOT EXISTS idx_sessions_home_operator ON sessions(home_operator) WHERE home_operator IS NOT NULL;
