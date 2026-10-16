// glossary-ignore: run
import type { Database } from "bun:sqlite";
import { subjectClass } from "./policy";
import { routeFor, type VigilRoute } from "./routing";

/** An unseen budget day starts at zero; reading never creates a row. */
export function getVigilTextsSpent(db: Database, budgetDay: string): number {
  return db.query<{ texts_spent: number }, [string]>(
    "SELECT texts_spent FROM vigil_budget WHERE budget_day = ?",
  ).get(budgetDay)?.texts_spent ?? 0;
}

/**
 * Record one confirmed text delivery, by DM or fallback (soma#823 Q5).
 * The delivery caller supplies the budget day and calls this only on success,
 * never for attempts, held events or the free digest. This is not a reservation.
 */
export function recordVigilTextDelivered(db: Database, budgetDay: string): void {
  db.query(`INSERT INTO vigil_budget (budget_day, texts_spent) VALUES (?, 1)
    ON CONFLICT(budget_day) DO UPDATE SET texts_spent = texts_spent + 1`).run(budgetDay);
}

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
  severity: "high" | "normal" | null;
  attention_id: string | null;
  route: VigilRoute | null;
  delivery: "pending" | "sent" | "held" | "digested";
  held_reason: "quiet" | "budget" | null;
  sent_at: number | null;
  via: "dm" | "email" | null;
  attempts: number;
  last_error: string | null;
  transient_failures: number;
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
): VigilEventRow {
  const subject = getVigilSubject(db, event.subject_key);
  if (!subject) throw new Error(`Vigil transition has no subject: ${event.subject_key}`);
  const route = routeFor(subjectClass(subject), event.to_value, event.direction);
  const id = crypto.randomUUID();
  db.query(`INSERT INTO vigil_events
    (id, subject_key, event_kind, from_value, to_value, direction, run_id, occurred_at, created_at, route, delivery)
    VALUES (?, ?, 'transition', ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
    id, event.subject_key, event.from_value, event.to_value,
    event.direction, event.run_id, event.occurred_at, now, route,
  );
  return {
    ...event, id, event_kind: "transition", created_at: now, severity: null, attention_id: null, route, delivery: "pending",
    held_reason: null, sent_at: null, via: null, attempts: 0, last_error: null, transient_failures: 0,
  };
}

export function markVigilTextSent(db: Database, id: string, via: "dm" | "email", now: number, day: string): void {
  db.transaction(() => {
    const updated = db.query(`UPDATE vigil_events SET delivery = 'sent', sent_at = ?, via = ?,
      held_reason = NULL, last_error = NULL, transient_failures = 0
      WHERE id = ? AND delivery = 'pending' AND route = 'text'`).run(now, via, id);
    if (updated.changes === 1) recordVigilTextDelivered(db, day);
  })();
}

// glossary-ignore: run
/**
 * Execution Run identifiers are myelin contract terms, not Cortex Sessions.
 * Observations are ordered by `(ended_at, run_id)`; only one past the latest
 * changes the row. A redelivered `run_id` (whatever its `ended_at`), one that
 * ended earlier, or one with the same `ended_at` and a lower `run_id` changes
 * nothing, so the row converges on the same latest observation whatever order
 * the deliveries arrive in.
 */
export function isNewObservation(prior: VigilSubjectRow | null, runId: string, endedAt: number): boolean {
  if (!prior) return true;
  if (runId === prior.last_run_id) return false;
  if (endedAt !== prior.last_ended_at) return endedAt > prior.last_ended_at;
  return runId > prior.last_run_id;
}

/** True when any subject row exists — an empty table triggers LEDGER replay. */
export function hasVigilSubjects(db: Database): boolean {
  return db.query("SELECT 1 FROM vigil_subjects LIMIT 1").get() !== null;
}

/** True while a LEDGER replay has started and not finished; startup retries it. */
export function isVigilReplayPending(db: Database): boolean {
  return db.query("SELECT 1 FROM vigil_replay WHERE id = 1").get() !== null;
}

export function markVigilReplayStarted(db: Database, now: number): void {
  db.query("INSERT OR REPLACE INTO vigil_replay (id, started_at) VALUES (1, ?)").run(now);
}

export function clearVigilReplay(db: Database): void {
  db.query("DELETE FROM vigil_replay WHERE id = 1").run();
}
