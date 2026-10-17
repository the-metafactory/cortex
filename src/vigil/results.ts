import type { Database } from "bun:sqlite";
import type { ExecutionRunFinishedPayload } from "@the-metafactory/myelin";
import { expireRefAttention, ingestRefAttention, REF_ATTENTION_TTL_MS, type VigilRefRow } from "./ref-attention";

export const RESULT_TTL_MS = REF_ATTENTION_TTL_MS;

export interface VigilResultRow extends VigilRefRow {
  result_ref: string;
}

export function ingestResult(
  db: Database, payload: ExecutionRunFinishedPayload,
  opts: { replay?: boolean; stackId?: string },
): void {
  if (payload.outcome !== "succeeded" || !payload.result_ref) return;
  const ref = payload.result_ref;
  const endedAt = Date.parse(payload.ended_at);
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
  ingestRefAttention(db, "result", ref, payload, opts);
}

export function expireResults(db: Database, now: number): void {
  expireRefAttention(db, now, "result");
}

export function pendingResults(db: Database): VigilResultRow[] {
  return db.query<VigilResultRow, []>(`SELECT r.* FROM vigil_results r
    JOIN attention_items a ON a.id = r.attention_id
    WHERE a.status = 'open' AND r.version > r.digested_version ORDER BY r.updated_at, r.result_ref`).all();
}
