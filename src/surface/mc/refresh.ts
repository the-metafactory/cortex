/**
 * ML.2 — cockpit refresh orchestrator (make-it-live runtime trigger).
 *
 * Chains the three deferred-until-now mechanisms into one principal-triggered
 * pass that pulls real data through the cockpit:
 *   1. plan-doc ingestion (D.2)      — docs/plan-*.md + iteration-*.md → Plan + phases
 *   2. work-item ingestion (D.5b)    — per plan, dispatched by provider → WorkItems
 *   3. attention reconcile (E.2)     — derive the open attention set from the new state
 *
 * Provider dispatch is INJECTED (`workItemSourceFor`) so the orchestrator stays
 * provider-neutral + testable; `defaultWorkItemSourceFor` is the production
 * factory (GitHub today, more providers as their sources land). Notification
 * publish (ML.3) consumes the reconcile result separately.
 */
import type { Database } from "bun:sqlite";
import type { Provider } from "./types";
import { ingestPlanDocsFromDir } from "./ingest/plan-docs";
import { ingestWorkItems, type WorkItemSource } from "./adapters/work-item-source";
import { GithubWorkItemSource } from "./adapters/github/work-items";
import { reconcileAttention } from "./db/attention-sources";
import {
  publishReconcileDelta,
  type AttentionNotifySource,
  type EnvelopePublisher,
} from "./attention-notify";
import type { AttentionItem } from "./types";

/** Map a plan's provider → the WorkItemSource that ingests its work items (null = unsupported). */
export type WorkItemSourceFactory = (provider: Provider) => WorkItemSource | null;

/**
 * Production dispatch: GitHub is the first (and today only) adapter. Other
 * providers return null until their WorkItemSource lands — the orchestrator
 * skips them (their plans still ingest as skeletons).
 */
export function defaultWorkItemSourceFor(provider: Provider): WorkItemSource | null {
  if (provider === "github") return new GithubWorkItemSource();
  return null;
}

export interface RefreshCockpitOptions {
  /** Absolute path to the docs dir holding the plan/iteration docs. */
  docsDir: string;
  /** Repo-relative prefix recorded on each plan's path (default "docs"). */
  repoRelDir?: string;
  /** Build a sourceDocumentUrl from a repo-relative path. */
  urlForPath?: (repoRelPath: string) => string | null;
  /** Default {owner, repo} for qualifying short umbrella refs (ML.1). */
  defaultRepo?: { owner: string; repo: string };
  /** Stack id stamped on produced attention items (E.2). */
  stackId: string;
  /** Provider → WorkItemSource dispatch. Defaults to {@link defaultWorkItemSourceFor}. */
  workItemSourceFor?: WorkItemSourceFactory;
  /** Stale threshold for attention (E.2). */
  staleAfterMs?: number;
  /** Injected current epoch seconds (deterministic tests). */
  nowEpochSec?: number;
  /**
   * ML.3 — optional bus publisher. When provided (with `notifySource`), the
   * reconcile delta is published as `system.attention.*` envelopes. Omitted by
   * the DB-only CLI trigger; supplied by the bot where the MyelinRuntime lives.
   */
  publish?: EnvelopePublisher;
  notifySource?: AttentionNotifySource;
  /** Builds a deep-link URL for an attention item (for the notification). */
  deepLinkFor?: (item: AttentionItem) => string | null;
}

export interface RefreshResult {
  /** Plans ingested from docs. */
  plans: number;
  /** Work items ingested across all plans. */
  workItems: number;
  /** Plans whose provider had no WorkItemSource (skipped ingestion). */
  unsupportedProviders: number;
  /** Plans whose work-item ingestion threw (isolated; reconcile still ran). */
  failedPlans: number;
  /** Open attention items after reconcile. */
  attentionOpen: number;
  /** Attention notifications published this run (0 when no publisher is wired). */
  notifiedOpened: number;
  notifiedResolved: number;
}

/**
 * Run one full cockpit refresh. Principal-triggered; safe to re-run (every step
 * is idempotent — upsert by deterministic id + reconcile diff).
 */
export async function refreshCockpit(db: Database, opts: RefreshCockpitOptions): Promise<RefreshResult> {
  const sourceFor = opts.workItemSourceFor ?? defaultWorkItemSourceFor;

  // 1. Plan docs → plans + phases (+ umbrella linkage from ML.1).
  const parsed = ingestPlanDocsFromDir(db, {
    docsDir: opts.docsDir,
    repoRelDir: opts.repoRelDir,
    urlForPath: opts.urlForPath,
    defaultRepo: opts.defaultRepo,
  });

  // 2. Per plan, dispatch a source by provider and ingest its work items.
  //    Isolate each plan: one provider source misbehaving must NOT abort the
  //    batch or skip the reconcile step (best-effort, matching the posture the
  //    GithubWorkItemSource already takes internally).
  let workItems = 0;
  let unsupportedProviders = 0;
  let failedPlans = 0;
  for (const { plan } of parsed) {
    const source = sourceFor(plan.provider);
    if (source === null) {
      unsupportedProviders += 1;
      continue;
    }
    try {
      const res = await ingestWorkItems(db, source, plan.id);
      workItems += res.workItems.length;
    } catch (err) {
      failedPlans += 1;
      process.stderr.write(
        `[cockpit-refresh] work-item ingestion failed for plan ${plan.id}: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  // 3. Reconcile attention from the freshly-ingested state.
  const attention = reconcileAttention(db, {
    stackId: opts.stackId,
    staleAfterMs: opts.staleAfterMs,
    nowEpochSec: opts.nowEpochSec,
  });

  // 4. ML.3 — publish the open/resolve delta onto the bus when a publisher is
  //    wired (the bot; the DB-only CLI omits it). Best-effort: never let a
  //    publish failure abort the refresh.
  let notifiedOpened = 0;
  let notifiedResolved = 0;
  if (opts.publish && !opts.notifySource) {
    process.stderr.write(
      "[cockpit-refresh] publisher supplied without notifySource — attention notifications skipped\n"
    );
  }
  if (opts.publish && opts.notifySource) {
    try {
      const n = await publishReconcileDelta(
        { opened: attention.opened, resolved: attention.resolved },
        { source: opts.notifySource, deepLinkFor: opts.deepLinkFor },
        opts.publish
      );
      notifiedOpened = n.opened;
      notifiedResolved = n.resolved;
    } catch (err) {
      process.stderr.write(
        `[cockpit-refresh] attention notification publish failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  return {
    plans: parsed.length,
    workItems,
    unsupportedProviders,
    failedPlans,
    attentionOpen: attention.open.length,
    notifiedOpened,
    notifiedResolved,
  };
}
