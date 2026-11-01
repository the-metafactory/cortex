export const SWEEP_SQL = [
  "CREATE TABLE IF NOT EXISTS desk_mail_sweeps (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, target TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, undone_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS desk_mail_sweep_mails (sweep_id TEXT NOT NULL, message_id TEXT NOT NULL, subject TEXT NOT NULL, move_id TEXT, status TEXT NOT NULL, error TEXT, PRIMARY KEY (sweep_id, message_id))",
];
