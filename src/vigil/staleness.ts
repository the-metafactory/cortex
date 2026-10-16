// glossary-ignore: run
import type { Database } from "bun:sqlite";
import { writeVigilTransition, type VigilSubjectRow } from "./db";
import { STALE_VALUE } from "./state-subject";

export const DEFAULT_CADENCE_MS = 26 * 60 * 60 * 1000;
export type VigilCadence = Readonly<Record<string, number>>;

/** Only job run-health and goal-vocabulary state subjects can become stale. */
export function effectiveCadenceMs(
  subject: Pick<VigilSubjectRow, "subject_key" | "subject_kind" | "run_kind" | "vocab">,
  cadence: VigilCadence,
): number | null {
  const eligible = subject.subject_kind === "run"
    ? subject.run_kind === "job"
    : subject.vocab === "goal";
  if (!eligible) return null;
  return cadence[subject.subject_key] ?? DEFAULT_CADENCE_MS;
}

/** A7c: silence strictly beyond twice the cadence is an ordinary worse transition. */
export function sweepStale(db: Database, now: number, cadence: VigilCadence): void {
  db.transaction(() => {
    const subjects = db.query<VigilSubjectRow, [string]>(`SELECT * FROM vigil_subjects
      WHERE value != ? AND ((subject_kind = 'run' AND run_kind = 'job')
        OR (subject_kind = 'state' AND vocab = 'goal'))`).all(STALE_VALUE);
    const update = db.query("UPDATE vigil_subjects SET value = ?, healthy = 0, updated_at = ? WHERE subject_key = ?");
    for (const subject of subjects) {
      const cadenceMs = effectiveCadenceMs(subject, cadence);
      if (cadenceMs === null || now - subject.last_ended_at <= 2 * cadenceMs) continue;
      update.run(STALE_VALUE, now, subject.subject_key);
      writeVigilTransition(db, {
        subject_key: subject.subject_key, from_value: subject.value, to_value: STALE_VALUE,
        direction: "worse", run_id: subject.last_run_id, occurred_at: now,
      }, now);
    }
  }).immediate();
}
