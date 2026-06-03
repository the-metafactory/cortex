/**
 * G-1113.E.1 — AttentionItem storage (design §6 / §7.4). Idempotent upsert by
 * id, get, list-open (queue order), and the resolve/dismiss lifecycle. Mirrors
 * the plans / work-items pattern: snake_case rows → camelCase domain types;
 * kind/severity/status are CHECK-backed in the schema so the casts are safe.
 *
 * Producers for each `kind` are wired in E.2; the queue UI is E.3; notification
 * routing is E.4. This slice lands the model + storage + lifecycle only.
 */
import type { Database } from "bun:sqlite";
import type { AttentionItem, AttentionKind, AttentionSeverity, AttentionStatus } from "../types";

interface AttentionRow {
  id: string;
  stack_id: string;
  work_item_id: string | null;
  session_id: string | null;
  kind: string;
  severity: string;
  status: string;
}

function rowToAttentionItem(r: AttentionRow): AttentionItem {
  return {
    id: r.id,
    stackId: r.stack_id,
    workItemId: r.work_item_id,
    sessionId: r.session_id,
    // kind / severity / status are CHECK-constrained in the schema.
    kind: r.kind as AttentionKind,
    severity: r.severity as AttentionSeverity,
    status: r.status as AttentionStatus,
  };
}

/** Insert or update an attention item by id (idempotent re-emission by a producer). */
export function upsertAttentionItem(db: Database, item: AttentionItem): void {
  db.query(
    `INSERT INTO attention_items
       (id, stack_id, work_item_id, session_id, kind, severity, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       stack_id = excluded.stack_id,
       work_item_id = excluded.work_item_id,
       session_id = excluded.session_id,
       kind = excluded.kind,
       severity = excluded.severity,
       status = excluded.status,
       updated_at = unixepoch()`
  ).run(
    item.id,
    item.stackId,
    item.workItemId,
    item.sessionId,
    item.kind,
    item.severity,
    item.status
  );
}

export function getAttentionItem(db: Database, id: string): AttentionItem | null {
  const row = db.query(`SELECT * FROM attention_items WHERE id = ?`).get(id) as AttentionRow | null;
  return row ? rowToAttentionItem(row) : null;
}

/**
 * Open items only, queue-ordered: critical → low, then oldest first (FIFO within
 * a severity). `critical|high|normal|low` isn't lexical, so order via a CASE rank.
 *
 * NB: idx_attention_status_severity serves the `status = 'open'` FILTER, not this
 * CASE-rank sort (the index is on the raw severity string), so SQLite still sorts
 * the open set — negligible at queue sizes; revisit with a numeric rank column if
 * the open queue ever grows large.
 */
export function listOpenAttention(db: Database): AttentionItem[] {
  const rows = db
    .query(
      `SELECT * FROM attention_items
       WHERE status = 'open'
       ORDER BY CASE severity
         WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         created_at, id`
    )
    .all() as AttentionRow[];
  return rows.map(rowToAttentionItem);
}

/** Lifecycle transition to a terminal state. Returns true if a row changed. */
function setStatus(db: Database, id: string, status: AttentionStatus): boolean {
  const res = db
    .query(`UPDATE attention_items SET status = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(status, id);
  return res.changes > 0;
}

/** Mark an item resolved (its underlying condition cleared). */
export function resolveAttentionItem(db: Database, id: string): boolean {
  return setStatus(db, id, "resolved");
}

/** Mark an item dismissed (the principal chose to clear it without action). */
export function dismissAttentionItem(db: Database, id: string): boolean {
  return setStatus(db, id, "dismissed");
}
