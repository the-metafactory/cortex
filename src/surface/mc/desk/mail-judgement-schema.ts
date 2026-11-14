export const MAIL_JUDGEMENT_SQL: string[] = [`
  CREATE TABLE IF NOT EXISTS desk_mail_judgement_operations (
    operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, request_id TEXT NOT NULL, scope TEXT NOT NULL,
    message_id TEXT NOT NULL, mail_json TEXT, change_json TEXT, result_json TEXT, undone INTEGER NOT NULL DEFAULT 0, undo_operation TEXT, created_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS desk_mail_judgement_undo_operation ON desk_mail_judgement_operations(undo_operation);
  CREATE TABLE IF NOT EXISTS desk_mail_judgement_list_versions (address TEXT PRIMARY KEY, token TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS desk_mail_judgement_row_versions (table_name TEXT NOT NULL, message_id TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY (table_name, message_id));
  INSERT OR IGNORE INTO desk_mail_judgement_list_versions SELECT address, lower(hex(randomblob(16))) FROM desk_unimportant;
  CREATE TRIGGER IF NOT EXISTS desk_mail_judgement_list_insert AFTER INSERT ON desk_unimportant BEGIN
    INSERT INTO desk_mail_judgement_list_versions VALUES (NEW.address, lower(hex(randomblob(16)))) ON CONFLICT(address) DO UPDATE SET token = excluded.token;
  END;
  CREATE TRIGGER IF NOT EXISTS desk_mail_judgement_list_update AFTER UPDATE ON desk_unimportant BEGIN
    INSERT INTO desk_mail_judgement_list_versions VALUES (NEW.address, lower(hex(randomblob(16)))) ON CONFLICT(address) DO UPDATE SET token = excluded.token;
  END;
  CREATE TRIGGER IF NOT EXISTS desk_mail_judgement_list_delete AFTER DELETE ON desk_unimportant BEGIN
    DELETE FROM desk_mail_judgement_list_versions WHERE address = OLD.address;
  END;
`, ...rowVersionTriggers()];

function rowVersionTriggers(): string[] {
  const statements: string[] = [];
  for (const table of ["desk_mail_snoozes", "desk_mail_waiting"]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      statements.push(`CREATE TRIGGER IF NOT EXISTS ${table}_judgement_${event} AFTER ${event} ON ${table} BEGIN
        INSERT INTO desk_mail_judgement_row_versions VALUES ('${table}', ${row}.message_id, lower(hex(randomblob(16)))) ON CONFLICT(table_name, message_id) DO UPDATE SET token = excluded.token;
      END;`);
    }
  }
  return statements;
}
