import type { Database } from "bun:sqlite";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import { getAttentionItem, setAttentionItemStatus, upsertAttentionItem } from "../surface/mc/db/attention";
import { isNewObservation } from "./db";

export const RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface VigilResultRow {
  result_ref: string;
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

export function ingestResult(
  db: Database, payload: ExecutionRunFinishedPayload,
  opts: { replay?: boolean; stackId?: string },
): void {
  if (payload.outcome !== "succeeded" || !payload.result_ref) return;
  const ref = payload.result_ref;
  const endedAt = Date.parse(payload.ended_at);
  const prior = db.query<VigilResultRow, [string]>("SELECT * FROM vigil_results WHERE result_ref = ?").get(ref);
  const subjects = db.query<{ subject_key: string }, [string]>(
    "SELECT subject_key FROM vigil_subjects WHERE last_run_id = ?",
  ).all(payload.run_id);
  for (const { subject_key: key } of subjects) {
    db.query(`INSERT INTO vigil_result_subjects (subject_key, result_ref, last_run_id, last_ended_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(subject_key) DO UPDATE SET
      result_ref = excluded.result_ref, last_run_id = excluded.last_run_id, last_ended_at = excluded.last_ended_at
      WHERE excluded.last_ended_at > last_ended_at OR
        (excluded.last_ended_at = last_ended_at AND excluded.last_run_id > last_run_id)`)
      .run(key, ref, payload.run_id, endedAt);
  }
  if (prior && !isNewObservation(prior, payload.run_id, endedAt)) return;
  if (prior && getAttentionItem(db, prior.attention_id)?.status !== "open") return;
  if (prior) {
    db.query(`UPDATE vigil_results SET last_run_id = ?, last_ended_at = ?, updated_at = ?, expires_at = ?,
      goal_id = ?, version = version + 1,
      digested_version = CASE WHEN ? THEN version + 1 ELSE digested_version END WHERE result_ref = ?`)
      .run(payload.run_id, endedAt, endedAt, endedAt + RESULT_TTL_MS, payload.serves?.goal ?? null, opts.replay ? 1 : 0, ref);
    return;
  }
  const id = `att:vigil:result:${ref}`;
  upsertAttentionItem(db, {
    id, stackId: opts.stackId ?? "default", workItemId: null, sessionId: null,
    kind: "result", severity: "low", status: "open",
  });
  db.query(`INSERT INTO vigil_results
    (result_ref, attention_id, ran_ref, created_run_id, created_ended_at, goal_id, last_run_id, last_ended_at, updated_at, expires_at, digested_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ref, id, payload.ran.ref, payload.run_id, endedAt, payload.serves?.goal ?? null, payload.run_id, endedAt, endedAt,
      endedAt + RESULT_TTL_MS, opts.replay ? 1 : 0);
  const siblings = db.query<VigilResultRow, [string, string]>(`SELECT r.* FROM vigil_results r
    JOIN attention_items a ON a.id = r.attention_id
    WHERE r.ran_ref = ? AND r.result_ref != ? AND a.status = 'open'`).all(payload.ran.ref, ref);
  for (const sibling of siblings) {
    const incomingIsLater = isNewObservation({ last_run_id: sibling.created_run_id, last_ended_at: sibling.created_ended_at }, payload.run_id, endedAt);
    setAttentionItemStatus(db, incomingIsLater ? sibling.attention_id : id, "resolved", "superseded");
  }
}

export function expireResults(db: Database, now: number): void {
  db.query(`UPDATE attention_items SET status = 'resolved', resolution = 'expired', updated_at = unixepoch()
    WHERE status = 'open' AND id IN
      (SELECT attention_id FROM vigil_results WHERE expires_at <= ?)`)
    .run(now);
}

export function pendingResults(db: Database): VigilResultRow[] {
  return db.query<VigilResultRow, []>(`SELECT r.* FROM vigil_results r
    JOIN attention_items a ON a.id = r.attention_id
    WHERE a.status = 'open' AND r.version > r.digested_version ORDER BY r.updated_at, r.result_ref`).all();
}
