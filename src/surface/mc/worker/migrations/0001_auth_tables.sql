-- GA-1 (1.6): Auth tables for grove-auth integration
-- Source: grove-auth/src/schema/001_auth_tables.sql
-- Apply: wrangler d1 execute grove-events --file=./migrations/0001_auth_tables.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer', 'operator', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  class TEXT NOT NULL DEFAULT 'pet' CHECK(class IN ('pet', 'cattle')),
  backend TEXT,
  spawn_profile TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS agent_grants (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read' CHECK(scope IN ('read', 'review', 'control')),
  requires_stepup INTEGER DEFAULT 1,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id),
  FOREIGN KEY (grantee_id) REFERENCES users(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_agent_owner ON agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_grant_grantee ON agent_grants(grantee_id);
CREATE INDEX IF NOT EXISTS idx_grant_agent ON agent_grants(agent_id);
