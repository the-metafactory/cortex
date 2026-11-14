export { HANDOFF_STATES, MAX_INSTRUCTION, OPEN_STATES, type HandoffState } from "./handoff";

export const MAX_FINDINGS = 5;
export const MAX_FINDING = 400;

export const HANDOFF_SQL = [
  `CREATE TABLE IF NOT EXISTS desk_mail_handoffs (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    account TEXT,
    source_id TEXT NOT NULL,
    area TEXT,
    from_name TEXT,
    from_address TEXT NOT NULL,
    subject TEXT NOT NULL,
    url TEXT,
    received_at TEXT NOT NULL,
    summary TEXT,
    text TEXT,
    instruction TEXT,
    route TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_url TEXT,
    state TEXT NOT NULL,
    model TEXT,
    findings TEXT,
    draft TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    closed_at INTEGER,
    task_close TEXT,
    task_close_error TEXT,
    task_close_tries INTEGER NOT NULL DEFAULT 0,
    task_close_tried_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS desk_mail_handoffs_message ON desk_mail_handoffs (message_id, created_at)",
  "CREATE INDEX IF NOT EXISTS desk_mail_handoffs_state ON desk_mail_handoffs (state, created_at)",
];

export const HANDOFF_COLUMNS = [
  { table: "desk_mail_handoffs", column: "task_close", ddl: "ALTER TABLE desk_mail_handoffs ADD COLUMN task_close TEXT" },
  { table: "desk_mail_handoffs", column: "task_close_error", ddl: "ALTER TABLE desk_mail_handoffs ADD COLUMN task_close_error TEXT" },
  { table: "desk_mail_handoffs", column: "task_close_tries", ddl: "ALTER TABLE desk_mail_handoffs ADD COLUMN task_close_tries INTEGER NOT NULL DEFAULT 0" },
  { table: "desk_mail_handoffs", column: "task_close_tried_at", ddl: "ALTER TABLE desk_mail_handoffs ADD COLUMN task_close_tried_at INTEGER" },
];
