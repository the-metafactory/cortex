import type { Database } from "bun:sqlite";
import { HANDOFF_KEY_PREFIX, LEGACY_ACTION_IDS, LEGACY_KEY_PREFIX } from "./handoff";

export const ASSISTANT_ROWS_MARKER = "assistant-ids-2026-11";

const renameKey = (table: string, column: string): string =>
  `UPDATE OR IGNORE ${table} SET ${column} = '${HANDOFF_KEY_PREFIX}' || substr(${column}, ${LEGACY_KEY_PREFIX.length + 1}) WHERE ${column} LIKE '${LEGACY_KEY_PREFIX}%'`;

/** Rewrites stored rows that carry the old hand-off ids, card keys and mail log action. Idempotent: a second pass matches nothing. */
export const ASSISTANT_ROW_MIGRATIONS: string[] = [
  "UPDATE desk_mail_log SET action = 'assistant' WHERE action = 'ivy'",
  ...Object.entries(LEGACY_ACTION_IDS).flatMap(([from, to]) => [
    `UPDATE desk_done SET action = '${to}' WHERE action = '${from}'`,
    `UPDATE OR IGNORE desk_grants SET action = '${to}' WHERE action = '${from}'`,
  ]),
  renameKey("desk_done", "item_key"),
  renameKey("desk_links", "from_key"),
  renameKey("desk_links", "to_key"),
  renameKey("desk_interrupt_feedback", "item_key"),
];

/** Renames the stored rows once per database; the marker row keeps later opens from scanning the tables again. */
export function migrateAssistantRows(db: Database, now: number = Date.now()): boolean {
  db.run("CREATE TABLE IF NOT EXISTS desk_data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  if (db.query("SELECT 1 FROM desk_data_migrations WHERE id = ?").get(ASSISTANT_ROWS_MARKER)) return false;
  db.transaction(() => {
    for (const sql of ASSISTANT_ROW_MIGRATIONS) db.run(sql);
    db.query("INSERT INTO desk_data_migrations (id, applied_at) VALUES (?, ?)").run(ASSISTANT_ROWS_MARKER, now);
  })();
  return true;
}
