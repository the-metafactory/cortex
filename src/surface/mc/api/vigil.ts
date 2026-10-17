import type { Database } from "bun:sqlite";
import type { VigilSubjectRow } from "../../../vigil/db";
import { idOnlyGoalWording, type GoalWordingResolver } from "../../../vigil/goal-wording";
import { effectiveCadenceMs, type VigilCadence } from "../../../vigil/staleness";

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

export interface VigilSubjectsResponse {
  subjects: VigilSubjectView[];
  enabled?: boolean;
}

export interface VigilSubjectsOptions {
  somaHome?: string;
  resultBaseUrl?: string;
  enabled: boolean;
  resolveGoalWording?: GoalWordingResolver;
  cadence?: VigilCadence;
}

export async function handleListVigilSubjects(
  db: Database,
  resolver: GoalWordingResolver = idOnlyGoalWording,
  cadence: VigilCadence = {},
): Promise<Response> {
  const rows = db.query<VigilSubjectRow, []>(
    "SELECT * FROM vigil_subjects ORDER BY healthy, subject_key",
  ).all();
  const wordingByGoal = new Map<string, Promise<string | null>>();
  async function goalWording(goalId: string): Promise<string | null> {
    try {
      return await resolver(goalId);
    } catch {
      process.stderr.write("Vigil Watching: goal wording unavailable; showing goal ID\n");
      return null;
    }
  }
  const subjects = await Promise.all(rows.map(async (row): Promise<VigilSubjectView> => {
    if (row.goal_id !== null && !wordingByGoal.has(row.goal_id)) {
      wordingByGoal.set(row.goal_id, goalWording(row.goal_id));
    }
    const cadenceMs = effectiveCadenceMs(row, cadence);
    return {
      subjectKey: row.subject_key,
      kind: row.subject_kind,
      vocab: row.vocab,
      ref: row.ref,
      goalId: row.goal_id,
      goalWording: row.goal_id === null ? null : await wordingByGoal.get(row.goal_id) ?? null,
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
  return Response.json({ subjects } satisfies VigilSubjectsResponse, {
    headers: { "Cache-Control": "no-store" },
  });
}
