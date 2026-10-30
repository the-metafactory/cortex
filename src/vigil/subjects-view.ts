import type { Database } from "bun:sqlite";
import type { VigilSubjectRow } from "./db";
import { idOnlyGoalWording, type GoalWordingResolver } from "./goal-wording";
import { effectiveCadenceMs, type VigilCadence } from "./staleness";

export interface VigilSubjectView {
  subjectKey: string;
  kind: VigilSubjectRow["subject_kind"];
  vocab: VigilSubjectRow["vocab"];
  ref: string;
  goalId: string | null;
  goalWording: string | null;
  value: string;
  healthy: boolean;
  lastResultRef: string | null;
  lastRunId: string;
  lastEndedAt: number;
  expectedBy: number | null;
}

export async function listVigilSubjects(
  db: Database,
  resolver: GoalWordingResolver = idOnlyGoalWording,
  cadence: VigilCadence = {},
): Promise<VigilSubjectView[]> {
  const rows = db.query<VigilSubjectRow, []>(
    "SELECT * FROM vigil_subjects ORDER BY healthy, subject_key",
  ).all();
  const wordingByGoal = new Map<string, Promise<string | null>>();
  async function goalWording(goalId: string, stack: string): Promise<string | null> {
    try {
      return await resolver(goalId, stack);
    } catch {
      process.stderr.write("Vigil Watching: goal wording unavailable; showing goal ID\n");
      return null;
    }
  }
  const subjects = await Promise.all(rows.map(async (row): Promise<VigilSubjectView> => {
    const goalId = row.goal_id ?? (row.vocab === "goal" ? row.ref : null);
    const goalKey = JSON.stringify([row.stack, goalId]);
    if (goalId !== null && !wordingByGoal.has(goalKey)) {
      wordingByGoal.set(goalKey, goalWording(goalId, row.stack));
    }
    const cadenceMs = effectiveCadenceMs(row, cadence);
    return {
      subjectKey: row.subject_key,
      kind: row.subject_kind,
      vocab: row.vocab,
      ref: row.ref,
      goalId,
      goalWording: goalId === null ? null : await wordingByGoal.get(goalKey) ?? null,
      value: row.value,
      healthy: row.healthy === 1,
      lastResultRef: db.query<{ result_ref: string }, [string]>(
        "SELECT result_ref FROM vigil_result_subjects WHERE subject_key = ?",
      ).get(row.subject_key)?.result_ref ?? null,
      lastRunId: row.last_run_id,
      lastEndedAt: row.last_ended_at,
      expectedBy: cadenceMs === null ? null : row.last_ended_at + cadenceMs,
    };
  }));
  return subjects;
}
