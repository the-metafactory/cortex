export const MAIL_LOOP_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_loop_grants (
    grant_id TEXT PRIMARY KEY,
    adapter_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    loop TEXT NOT NULL,
    actions TEXT NOT NULL,
    selection TEXT NOT NULL,
    authority_grant_id TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_loop_grants_active ON desk_mail_loop_grants (loop, connection_id, status)",
  `CREATE TABLE IF NOT EXISTS desk_mail_loop_state (
    loop TEXT PRIMARY KEY,
    paused_at INTEGER
  )`,
];
