/**
 * G-1113.D.3 — plan overview projection + endpoint (design §7.1).
 *
 * Each plan with its ordered phases and a phase-status tally, for the Plans
 * surface. Read-only over the D.1 storage / D.2-ingested rows.
 *
 * Honest-data scope: per-phase WI/PR/release/attention counts (design §7.1)
 * are NOT projected here — that data doesn't exist until work-item linkage
 * (D.5+). We surface only what the skeleton genuinely knows: phase order +
 * status. `currentPhaseId` is the first phase explicitly marked `active`
 * (by phase order), or null when none is — so the UI highlights a current
 * phase only when the data actually marks one, and never guesses from order.
 */
import type { Database } from "bun:sqlite";
import type { Plan, PlanPhase, PlanPhaseStatus } from "../types";
import { listPlans, listPhasesForPlan } from "../db/plans";

export type PhaseStatusCounts = Record<PlanPhaseStatus, number>;

export interface PlanOverview {
  plan: Plan;
  phases: PlanPhase[];
  /**
   * The first phase explicitly marked `active` (by phase order), or null when
   * none is. No single-active invariant is enforced upstream (the schema CHECK
   * only constrains the status value), so a malformed multi-active plan
   * resolves to the earliest active phase rather than signalling ambiguity.
   */
  currentPhaseId: string | null;
  /** Tally of phases by status, for the card's progress line. */
  phaseCounts: PhaseStatusCounts;
}

function emptyCounts(): PhaseStatusCounts {
  return { not_started: 0, active: 0, blocked: 0, done: 0, cancelled: 0 };
}

/** One child query per plan (listPhasesForPlan) — N+1, acceptable for an overview (few plans). */
export function getPlansOverview(db: Database): PlanOverview[] {
  return listPlans(db).map((plan) => {
    const phases = listPhasesForPlan(db, plan.id);
    const phaseCounts = emptyCounts();
    for (const ph of phases) phaseCounts[ph.status] += 1;
    const active = phases.find((p) => p.status === "active");
    return { plan, phases, currentPhaseId: active?.id ?? null, phaseCounts };
  });
}

/** GET /api/plans — plans with ordered phases + phase-status tally. */
export function handleListPlans(db: Database): Response {
  return new Response(JSON.stringify({ plans: getPlansOverview(db) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
