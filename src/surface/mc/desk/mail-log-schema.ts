export const MAIL_LOG_ACTIONS = ["archive", "junk", "trash", "restore", "unimportant", "draft", "plan", "todo", "snooze", "opened", "ignored", "kept", "gone", "digest"] as const;
export type MailLogAction = (typeof MAIL_LOG_ACTIONS)[number];

export const MAIL_LOG_WHERE = ["desk", "client", "rule", "correction"] as const;
export type MailLogWhere = (typeof MAIL_LOG_WHERE)[number];

export const DEFAULT_MAIL_LOG_RETENTION_DAYS = 180;

export const MAIL_LOG_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    account TEXT,
    source_id TEXT,
    sender TEXT NOT NULL,
    sender_domain TEXT NOT NULL,
    list_id TEXT,
    category TEXT,
    subject TEXT,
    summary TEXT,
    action TEXT NOT NULL,
    origin TEXT NOT NULL,
    folder TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_log_message ON desk_mail_log (message_id, created_at)",
  "CREATE INDEX IF NOT EXISTS desk_mail_log_time ON desk_mail_log (created_at)",
  "CREATE INDEX IF NOT EXISTS desk_mail_log_sender ON desk_mail_log (sender_domain, created_at)",
];

export const MAIL_VECTORS_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_vectors (
    text_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    vector BLOB NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY (text_hash, model)
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_vectors_used ON desk_mail_vectors (used_at)",
];
