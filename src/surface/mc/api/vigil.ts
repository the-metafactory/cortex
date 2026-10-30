import type { Database } from "bun:sqlite";
import type { ProposalFilingOptions } from "../../../vigil/file-proposal";
import { idOnlyGoalWording, type GoalWordingResolver } from "../../../vigil/goal-wording";
import type { VigilCadence } from "../../../vigil/staleness";
import { listVigilSubjects, type VigilSubjectView } from "../../../vigil/subjects-view";

export type { VigilSubjectView };

export interface VigilSubjectsResponse {
  subjects: VigilSubjectView[];
  enabled?: boolean;
}

export interface VigilSubjectsOptions extends ProposalFilingOptions {
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
  const subjects = await listVigilSubjects(db, resolver, cadence);
  return Response.json({ subjects } satisfies VigilSubjectsResponse, {
    headers: { "Cache-Control": "no-store" },
  });
}
