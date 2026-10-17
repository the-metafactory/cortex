import type { Database } from "bun:sqlite";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import { getAttentionItem, setAttentionItemStatus, upsertAttentionItem } from "../surface/mc/db/attention";
import { isNewObservation } from "./db";

export const REF_ATTENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const REF_RULES = {
  result: { table: "vigil_results", refColumn: "result_ref", limit: 1, overflow: "superseded" },
  proposal: { table: "vigil_proposals", refColumn: "proposal_ref", limit: 20, overflow: "archived" },
} as const;

type RefKind = keyof typeof REF_RULES;

export interface VigilRefRow {
  attention_id: string;
  ran_ref: string;
  created_run_id: string;
  created_ended_at: number;
  goal_id: string | null;
  last_run_id: string;
  last_ended_at: number;
  updated_at: number;
  expires_at: number;
  version: number;
  digested_version: number;
}

export function ingestRefAttention(
  db: Database, kind: RefKind, ref: string, payload: ExecutionRunFinishedPayload,
  opts: { replay?: boolean; stackId?: string },
): void {
  const { table, refColumn, limit, overflow } = REF_RULES[kind];
  const endedAt = Date.parse(payload.ended_at);
  const prior = db.query<VigilRefRow, [string]>(`SELECT * FROM ${table} WHERE ${refColumn} = ?`).get(ref);
  if (prior && !isNewObservation(prior, payload.run_id, endedAt)) return;
  if (prior && getAttentionItem(db, prior.attention_id)?.status !== "open") return;
  if (prior) {
    db.query(`UPDATE ${table} SET last_run_id = ?, last_ended_at = ?, updated_at = ?, expires_at = ?,
      goal_id = ?, version = version + 1,
      digested_version = CASE WHEN ? THEN version + 1 ELSE digested_version END WHERE ${refColumn} = ?`)
      .run(payload.run_id, endedAt, endedAt, endedAt + REF_ATTENTION_TTL_MS, payload.serves?.goal ?? null, opts.replay ? 1 : 0, ref);
    db.query("UPDATE attention_items SET updated_at = unixepoch() WHERE id = ?").run(prior.attention_id);
    return;
  }
  const id = `att:vigil:${kind}:${ref}`;
  upsertAttentionItem(db, {
    id, stackId: opts.stackId ?? "default", workItemId: null, sessionId: null,
    kind, severity: "low", status: "open",
  });
  db.query(`INSERT INTO ${table}
    (${refColumn}, attention_id, ran_ref, created_run_id, created_ended_at, goal_id, last_run_id, last_ended_at, updated_at, expires_at, digested_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ref, id, payload.ran.ref, payload.run_id, endedAt, payload.serves?.goal ?? null, payload.run_id, endedAt, endedAt,
      endedAt + REF_ATTENTION_TTL_MS, opts.replay ? 1 : 0);
  const excess = db.query<{ attention_id: string }, [string, number]>(`SELECT r.attention_id FROM ${table} r
    JOIN attention_items a ON a.id = r.attention_id
    WHERE r.ran_ref = ? AND a.status = 'open'
    ORDER BY r.created_ended_at DESC, r.created_run_id DESC, r.${refColumn} DESC LIMIT -1 OFFSET ?`)
    .all(payload.ran.ref, limit);
  for (const item of excess) setAttentionItemStatus(db, item.attention_id, "resolved", overflow);
}

export function expireRefAttention(db: Database, now: number, kind?: RefKind): void {
  for (const { table } of kind ? [REF_RULES[kind]] : Object.values(REF_RULES)) {
    db.query(`UPDATE attention_items SET status = 'resolved', resolution = 'expired', updated_at = unixepoch()
      WHERE status = 'open' AND id IN (SELECT attention_id FROM ${table} WHERE expires_at <= ?)`)
      .run(now);
  }
}
