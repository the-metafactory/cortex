// glossary-ignore: run
import type { Database } from "bun:sqlite";

export interface VigilSubjectRow {
  subject_key: string;
  subject_kind: "run" | "state";
  vocab: "goal" | "escalation" | "check" | "unknown" | null;
  ref: string;
  value: string;
  healthy: 0 | 1;
  goal_id: string | null;
  producer: string;
  /** Stack segment of the latest observation's `source`; see `runHealthKey`. */
  stack: string;
  run_kind: string | null;
  last_run_id: string;
  last_ended_at: number;
  last_seen_at: number;
  cadence_ms: number;
  updated_at: number;
}

export interface VigilEventRow {
  id: string;
  subject_key: string;
  event_kind: "transition";
  from_value: string | null;
  to_value: string;
  direction: "worse" | "better";
  run_id: string;
  occurred_at: number;
  created_at: number;
}

export function getVigilSubject(db: Database, key: string): VigilSubjectRow | null {
  return db.query<VigilSubjectRow, [string]>("SELECT * FROM vigil_subjects WHERE subject_key = ?").get(key);
}

export function listVigilEvents(db: Database, key: string): VigilEventRow[] {
  return db.query<VigilEventRow, [string]>(
    "SELECT * FROM vigil_events WHERE subject_key = ? ORDER BY created_at, rowid",
  ).all(key);
}
