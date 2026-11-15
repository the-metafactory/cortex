export const MAIL_SWEEP_ADAPTER_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_sweep_grants (
    grant_id TEXT PRIMARY KEY,
    adapter_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    target TEXT NOT NULL,
    rule TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_sweep_grants_active ON desk_mail_sweep_grants (connection_id, target, status)",
  `CREATE TABLE IF NOT EXISTS desk_mail_sweep_sets (
    sweep_id TEXT PRIMARY KEY,
    adapter_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    account TEXT NOT NULL,
    target TEXT NOT NULL,
    rule TEXT NOT NULL,
    digest TEXT NOT NULL,
    count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_sweep_sets_connection ON desk_mail_sweep_sets (connection_id, created_at)",
  `CREATE TABLE IF NOT EXISTS desk_mail_sweep_set_mails (
    sweep_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    authority_grant_id TEXT,
    PRIMARY KEY (sweep_id, position)
  )`,
];
