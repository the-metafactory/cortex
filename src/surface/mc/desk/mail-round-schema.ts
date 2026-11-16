export const MAIL_ROUND_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS desk_mail_round_operations (
    request_id TEXT PRIMARY KEY,
    binding TEXT NOT NULL,
    round_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('put-back','undo')),
    token TEXT NOT NULL,
    state TEXT NOT NULL CHECK(json_valid(state)),
    result TEXT NOT NULL CHECK(json_valid(result)),
    undone_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS desk_mail_round_operation_token ON desk_mail_round_operations(token) WHERE kind = 'put-back'",
  "CREATE INDEX IF NOT EXISTS desk_mail_round_operation_round ON desk_mail_round_operations(round_id)",
];

export const MAIL_ROUND_COLUMNS = [
  { table: "desk_mail_round_queue", column: "put_back", ddl: "ALTER TABLE desk_mail_round_queue ADD COLUMN put_back INTEGER NOT NULL DEFAULT 0" },
];
