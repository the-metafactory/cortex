export const UNSUBSCRIBE_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_unsubscribes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    list_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    host TEXT NOT NULL,
    status TEXT NOT NULL,
    http_status INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_unsubscribes_key ON desk_mail_unsubscribes (list_key, created_at)",
];

export interface UnsubscribeConfig {
  enabled: boolean;
  after: number;
  timeoutSeconds: number;
}

export const DEFAULT_UNSUBSCRIBE: UnsubscribeConfig = { enabled: true, after: 5, timeoutSeconds: 10 };
