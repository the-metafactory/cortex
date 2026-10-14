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

/** Fields one observation writes; `subject_kind`, `vocab` and `ref` are fixed by the key. */
export type VigilObservation = Omit<VigilSubjectRow, "cadence_ms" | "updated_at">;

/** Upsert keeps `cadence_ms` and the key-derived columns of an existing row. */
export function writeVigilSubject(db: Database, row: VigilObservation, now: number): void {
  db.query(`INSERT INTO vigil_subjects
    (subject_key, subject_kind, vocab, ref, value, healthy, goal_id, producer, stack,
     run_kind, last_run_id, last_ended_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject_key) DO UPDATE SET
      value = excluded.value, healthy = excluded.healthy, goal_id = excluded.goal_id,
      producer = excluded.producer, stack = excluded.stack, run_kind = excluded.run_kind,
      last_run_id = excluded.last_run_id, last_ended_at = excluded.last_ended_at,
      last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`).run(
    row.subject_key, row.subject_kind, row.vocab, row.ref, row.value, row.healthy, row.goal_id,
    row.producer, row.stack, row.run_kind, row.last_run_id, row.last_ended_at, row.last_seen_at, now,
  );
}

export function writeVigilTransition(
  db: Database,
  event: Pick<VigilEventRow, "subject_key" | "from_value" | "to_value" | "direction" | "run_id" | "occurred_at">,
  now: number,
): void {
  db.query(`INSERT INTO vigil_events
    (id, subject_key, event_kind, from_value, to_value, direction, run_id, occurred_at, created_at)
    VALUES (?, ?, 'transition', ?, ?, ?, ?, ?, ?)`).run(
    crypto.randomUUID(), event.subject_key, event.from_value, event.to_value,
    event.direction, event.run_id, event.occurred_at, now,
  );
}

/** A redelivered run, or one that ended before the latest observation, changes nothing. */
export function isNewObservation(prior: VigilSubjectRow | null, runId: string, endedAt: number): boolean {
  return !prior || (endedAt >= prior.last_ended_at && runId !== prior.last_run_id);
}
