/**
 * G-1113.D.5 — work-item detail projection + endpoint (design §7.3).
 *
 * The operational drill-down for a single work item: its plan/phase context
 * and its linked pull requests (each with their reviews).
 *
 * Honest-data scope: §7.3 also lists current session, event log, checks/builds,
 * a principal input box, and curation actions (dispatch/requeue/abandon/hand
 * off). Of those:
 *   - sessions/event-log link via assignment→task, NOT to a work item (no
 *     work_item column), so they aren't projected here;
 *   - checks link by commit SHA, which a PullRequest row doesn't carry, so the
 *     PR→check path isn't queryable yet (deepens when head-sha plumbing lands);
 *   - curation actions operate on the legacy assignment lifecycle, which work
 *     items aren't wired to.
 * So D.5 surfaces what's genuinely linked today — plan/phase + PRs + reviews —
 * and leaves the rest for later slices rather than rendering fabricated panels.
 */
import type { Database } from "bun:sqlite";
import type { Plan, PlanPhase, WorkItem, PullRequest, Review } from "../types";
import { getPlan, getPlanPhase } from "../db/plans";
import { getWorkItem } from "../db/work-items";
import { listPullRequestsForWorkItem, listReviewsForPullRequest } from "../db/git-objects";

export interface PullRequestWithReviews {
  pullRequest: PullRequest;
  reviews: Review[];
}

export interface WorkItemDetail {
  workItem: WorkItem;
  /** Owning plan, when the work item is filed under one. */
  plan: Plan | null;
  /** Owning phase, when the work item is filed under one. */
  phase: PlanPhase | null;
  pullRequests: PullRequestWithReviews[];
}

/** Project a single work item with its plan/phase context + linked PRs (each with reviews). Null if unknown. */
export function getWorkItemDetail(db: Database, workItemId: string): WorkItemDetail | null {
  const workItem = getWorkItem(db, workItemId);
  if (!workItem) return null;
  const plan = workItem.planId !== null ? getPlan(db, workItem.planId) : null;
  const phase = workItem.phaseId !== null ? getPlanPhase(db, workItem.phaseId) : null;
  const pullRequests = listPullRequestsForWorkItem(db, workItemId).map((pullRequest) => ({
    pullRequest,
    reviews: listReviewsForPullRequest(db, pullRequest.id),
  }));
  return { workItem, plan, phase, pullRequests };
}

/** GET /api/work-items/:id — work-item detail; 404 if unknown. */
export function handleGetWorkItemDetail(db: Database, workItemId: string): Response {
  const detail = getWorkItemDetail(db, workItemId);
  if (!detail) {
    return new Response(JSON.stringify({ error: "work item not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(detail), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
