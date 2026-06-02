/**
 * G-1113.D.4 — phase-detail projection + endpoint (design §7.2).
 *
 * A single phase with its parent plan and the work items filed under it, each
 * work item carrying its linked pull requests (via PullRequest.workItemId).
 *
 * Honest-data scope: §7.2 also lists sessions, branches, checks/reviews, and
 * attention items. Of those, only PR linkage is queryable today —
 * `pull_requests.work_item_id` exists + is indexed. Sessions have no work-item
 * column (they link via assignment→task), and attention items are Phase E. So
 * those sections are intentionally NOT projected here; they deepen in later
 * slices as the linkage lands. Work items themselves are empty until WorkItem
 * ingestion (a filed D.4 follow-up) — the surface shows an honest empty state.
 */
import type { Database } from "bun:sqlite";
import type { Plan, PlanPhase, WorkItem, PullRequest } from "../types";
import { getPlan, getPlanPhase } from "../db/plans";
import { listWorkItemsForPhase } from "../db/work-items";
import { listPullRequestsForWorkItem } from "../db/git-objects";

export interface WorkItemWithLinks {
  workItem: WorkItem;
  pullRequests: PullRequest[];
}

export interface PhaseDetail {
  phase: PlanPhase;
  /** Parent plan, when the phase's plan row resolves (it always should via FK). */
  plan: Plan | null;
  workItems: WorkItemWithLinks[];
}

/** Project a single phase with its plan + work items (each with linked PRs). Null if the phase is unknown. */
export function getPhaseDetail(db: Database, phaseId: string): PhaseDetail | null {
  const phase = getPlanPhase(db, phaseId);
  if (!phase) return null;
  const plan = getPlan(db, phase.planId);
  const workItems = listWorkItemsForPhase(db, phaseId).map((workItem) => ({
    workItem,
    pullRequests: listPullRequestsForWorkItem(db, workItem.id),
  }));
  return { phase, plan, workItems };
}

/** GET /api/phases/:id — phase detail (plan + work items + linked PRs); 404 if unknown. */
export function handleGetPhaseDetail(db: Database, phaseId: string): Response {
  const detail = getPhaseDetail(db, phaseId);
  if (!detail) {
    return new Response(JSON.stringify({ error: "phase not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
