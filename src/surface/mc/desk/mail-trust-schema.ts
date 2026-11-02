export const TRUST_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_trusted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dismissal TEXT NOT NULL,
    sender TEXT NOT NULL,
    code TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    subject TEXT,
    log_id INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (sender, code, message_id)
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_trusted_dismissal ON desk_mail_trusted (dismissal)",
];
