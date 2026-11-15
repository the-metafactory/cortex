import type { Database } from "bun:sqlite";
import { writeVigilSubject } from "../../../../vigil/db";

export function seedDeskEscalation(db: Database, now: number): string {
  const subjectKey = "state:escalation:default:example/app#12";
  writeVigilSubject(db, {
    subject_key: subjectKey, subject_kind: "state", vocab: "escalation", ref: "example/app#12",
    value: "needs-principal", healthy: 0, goal_id: null, producer: "soma", stack: "default", run_kind: null,
    last_run_id: "run-1", last_ended_at: now, last_seen_at: now,
  }, now);
  return subjectKey;
}
