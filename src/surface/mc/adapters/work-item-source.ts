/**
 * G-1113.D.5b — provider-neutral WorkItem ingestion.
 *
 * `WorkItemSource` is the contract ANY provider's work-item ingester satisfies:
 * given a plan + its phases, it returns provider-neutral {@link WorkItem} rows.
 * `ingestWorkItems` is the provider-agnostic orchestrator — it resolves the
 * plan, asks the source for rows, and persists them transactionally. GitHub is
 * the first adapter implemented against this (see adapters/github/work-items.ts),
 * but nothing here knows about GitHub — adding GitLab/Jira/Linear is "write
 * another `WorkItemSource`", exactly as Phase B established for `SourceRef`.
 */
import type { Database } from "bun:sqlite";
import type { Plan, PlanPhase, Provider, WorkItem } from "../types";
import { getPlan, listPhasesForPlan } from "../db/plans";
import { upsertWorkItem } from "../db/work-items";

/** What a source is given to normalize work items for a single plan. */
export interface WorkItemSourceContext {
  plan: Plan;
  /** The plan's phases (ordered), so a source can map work items → phaseId. */
  phases: PlanPhase[];
}

/** Provider-neutral work-item ingester. One implementation per provider. */
export interface WorkItemSource {
  /** The provider this source emits work items for. */
  readonly provider: Provider;
  /**
   * Fetch + normalize the plan's work items into provider-neutral rows.
   * Persistence-free — the orchestrator persists. Returns `[]` when the source
   * has nothing to ingest (e.g. the plan carries no link to this provider).
   */
  fetchWorkItems(ctx: WorkItemSourceContext): Promise<WorkItem[]>;
}

export interface IngestResult {
  /** The work items the source produced (and that were persisted). */
  workItems: WorkItem[];
}

/**
 * Orchestrate ingestion for one plan through a given source. Resolves the plan
 * + phases, delegates normalization to the source, and upserts the rows in a
 * single transaction (idempotent by id). Returns an empty result when the plan
 * is unknown or the source produces nothing.
 */
export async function ingestWorkItems(
  db: Database,
  source: WorkItemSource,
  planId: string
): Promise<IngestResult> {
  const plan = getPlan(db, planId);
  if (!plan) return { workItems: [] };
  const phases = listPhasesForPlan(db, planId);
  const workItems = await source.fetchWorkItems({ plan, phases });
  if (workItems.length > 0) {
    const persist = db.transaction(() => {
      for (const wi of workItems) upsertWorkItem(db, wi);
    });
    persist();
  }
  return { workItems };
}
