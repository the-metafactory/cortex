-- Grove Cloud API — D1 Schema
-- Derived from dashboard-db.ts, with principal_id for multi-principal attribution.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  project TEXT,
  description TEXT,
  github_issue TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  status TEXT DEFAULT 'active',
  pr_url TEXT,
  events_count INTEGER DEFAULT 0,
  last_event TEXT,
  last_event_at TEXT,
  progress_completed INTEGER,
  progress_total INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_usd REAL,
  -- IAW D.5: sovereignty fields lifted off the originating myelin envelope.
  -- All three are NULL for pre-IAW publishers. See migrations/0003_sovereignty.sql.
  classification TEXT,        -- 'local' | 'federated' | 'public' | NULL
  data_residency TEXT,        -- e.g. 'nz', 'eu', NULL
  home_principal TEXT,         -- principal.home_principal (post-`did:mf:` strip)
  -- ST-P0 / ADR-0011 canonical session-tree fields. Defined ONCE in
  -- ../db/canonical-session.ts (CANONICAL_SESSION_COLUMNS) and asserted against
  -- this DDL + ../db/schema.ts by ../__tests__/session-schema-parity.test.ts.
  -- The cloud sessions row was already flat (agent_id/agent_name/principal_id/
  -- status/metrics/sovereignty are columns above) — these two close the gap.
  -- Added to deployed D1 via migrations/0005_session_tree.sql.
  parent_session_id TEXT,                   -- self-ref to the spawning session; NULL ⇒ agent-rooted
  substrate TEXT NOT NULL DEFAULT 'claude-code',  -- claude-code | codex | … (attribute of a session)
  -- CK-4a / #1295 / D-8 canonical: the ORIGIN-stack attribution the cross-stack
  -- WORKING aggregation (DashboardSnapshot.workingAggregation) groups by. NULL ⇒
  -- own/local-stack origin. Added to deployed D1 via migrations/0006_session_origin_stack.sql.
  origin_stack_id TEXT
);

CREATE TABLE IF NOT EXISTS github_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE,
  principal_id TEXT,
  repo TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT,
  number INTEGER,
  url TEXT,
  author TEXT,
  agent_authored INTEGER DEFAULT 0,
  linked_session TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  received_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repos (
  full_name TEXT PRIMARY KEY,
  short_name TEXT NOT NULL,
  description TEXT,
  default_branch TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL,
  author TEXT,
  labels TEXT,
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT,
  UNIQUE(repo, number)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  author TEXT,
  branch TEXT,
  base TEXT,
  agent_authored INTEGER DEFAULT 0,
  linked_issues TEXT,
  created_at TEXT,
  updated_at TEXT,
  merged_at TEXT,
  UNIQUE(repo, number)
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT,
  source TEXT NOT NULL,
  five_hour_pct REAL,
  five_hour_resets TEXT,
  seven_day_pct REAL,
  seven_day_resets TEXT,
  seven_day_opus_pct REAL,
  seven_day_sonnet_pct REAL,
  extra_usage_enabled INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- G-410: Per-session activity log (tool use, file changes, etc.)
CREATE TABLE IF NOT EXISTS session_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  icon TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT NOT NULL
);

-- S-005: Audit log for auth events
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,        -- 'api_key_auth', 'admin_auth', 'cf_access_auth', 'rate_limit'
  result TEXT NOT NULL,            -- 'success', 'failure'
  ip TEXT,
  endpoint TEXT,
  method TEXT,
  identity TEXT,                   -- principal_id, email, or admin
  detail TEXT                      -- failure reason or extra context
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_session_activity_session ON session_activity(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_completed ON sessions(completed_at);
CREATE INDEX IF NOT EXISTS idx_sessions_principal ON sessions(principal_id);
-- IAW D.5 — slicing the dashboard snapshot by home_principal on every poll
CREATE INDEX IF NOT EXISTS idx_sessions_home_principal ON sessions(home_principal) WHERE home_principal IS NOT NULL;
-- ST-P0 / ADR-0011 — session-tree lookups (children of a session; sessions per
-- substrate). Mirror of the local indices; names are the canonical contract
-- (CANONICAL_SESSION_INDICES) the parity test pins on both substrates.
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_substrate ON sessions(substrate);
-- CK-4a / #1295 — cross-stack aggregation groups WORKING metadata by origin stack.
CREATE INDEX IF NOT EXISTS idx_sessions_origin_stack_id ON sessions(origin_stack_id);
CREATE INDEX IF NOT EXISTS idx_github_repo ON github_events(repo, created_at);
CREATE INDEX IF NOT EXISTS idx_github_agent ON github_events(agent_authored, created_at);
CREATE INDEX IF NOT EXISTS idx_github_principal ON github_events(principal_id);
CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo, state);
CREATE INDEX IF NOT EXISTS idx_prs_repo_state ON pull_requests(repo, state);
CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_snapshots(recorded_at);
