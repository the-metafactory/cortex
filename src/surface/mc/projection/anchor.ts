/**
 * MC-I1.S6 (#848) — shared dispatch-anchor join (the #862-review cheap-fold 1).
 *
 * S4's dispatch-lifecycle projection anchors one MC task per dispatch
 * `correlation_id` under the deterministic id `mc-dispatch-task-{correlation_id}`,
 * with a non-cancelled assignment → most-recent session hanging off it. The S6
 * verdict + heartbeat projections JOIN onto that anchor's session by the SAME
 * correlation_id (the review consumer / dispatch handler stamp it on the
 * verdict / heartbeat envelopes too).
 *
 * The `ANCHOR_TASK_PREFIX` constant + the correlation_id→anchor-task→session
 * `SELECT` were copy-pasted across three sites (dispatch-lifecycle.ts,
 * review-verdict.ts, heartbeat.ts) — slightly ironic in a slice whose theme is
 * the `ensureAgentRow` DRY pickup (#861 finding 3). This module is the single
 * home: a schema change to the anchor join (the `agent_task_assignment` /
 * `sessions` shape, or the tiebreak) now lands in ONE place.
 */

import type { Database } from "bun:sqlite";

import { upsertWorkItem, getWorkItem } from "../db/work-items";

/**
 * Deterministic MC task id prefix for a dispatch correlation_id. One MC task per
 * dispatch (`dispatch-lifecycle.ts` mints `${ANCHOR_TASK_PREFIX}${correlationId}`
 * on `started`; the verdict / heartbeat joins read it back).
 */
export const ANCHOR_TASK_PREFIX = "mc-dispatch-task-";

/** The deterministic anchor-task id for a correlation_id. */
export function anchorTaskId(correlationId: string): string {
  return `${ANCHOR_TASK_PREFIX}${correlationId}`;
}

/**
 * Find the dispatch anchor's session for a `correlation_id`: the anchor task →
 * its assignment → most-recent session (the `ORDER BY s.started_at DESC, s.id
 * DESC LIMIT 1` tiebreak matches `dispatch-lifecycle.ts`'s own anchor lookup so
 * verdict/heartbeat land on the SAME session the lifecycle projection drives).
 * Returns the session id, or null when no anchor exists for the correlation_id.
 */
export function findAnchorSession(
  db: Database,
  correlationId: string,
): string | null {
  const row = db
    .query(
      `SELECT s.id AS session_id
       FROM agent_task_assignment a
       JOIN sessions s ON s.assignment_id = a.id
       WHERE a.task_id = ?
       ORDER BY s.started_at DESC, s.id DESC
       LIMIT 1`,
    )
    .get(anchorTaskId(correlationId)) as { session_id: string } | null;
  return row ? row.session_id : null;
}

// ---------------------------------------------------------------------------
// Slice convergence C (cortex#1150 / docs/design-slice-activity-thread.md §C):
// the slice IS the issue's `work_item`. The slice address `{repo}/issue/N`
// rides every dispatch as `response_routing.thread` (slice convergence A); MC
// resolves it to ONE work_item per issue and links the per-dispatch anchor
// `task` to it, so the slice card rolls up all of a slice's dispatches.
//
// This is the anchor-join schema change the module docblock anticipated — a
// `work_item` reference on the anchor task — landing here in the single anchor
// home, alongside the correlation_id→anchor join (which stays intact).
// ---------------------------------------------------------------------------

/**
 * A slice address parsed from a dispatch's `response_routing.thread`. The thread
 * is the channel-routing SOP's `{repo}/issue/N` form — a SHORT repo name (the
 * `#<repo-short>` channel convention), not `owner/repo`. The projection is
 * config-free (no `github.repos` to resolve short→owner/repo), so the SHORT
 * repo name is the convergence key both this projection and a per-slice GitHub
 * issue enrichment key off — see {@link workItemIdForSlice}.
 */
export interface SliceRef {
  repo: string;
  issueNumber: number;
}

/** `{repo}/issue/N` — the channel-routing SOP slice-thread form. */
const SLICE_THREAD_RE = /^([^/]+)\/issue\/(\d+)$/;

/**
 * Parse a `response_routing.thread` as a slice address. Returns null for any
 * non-issue thread (e.g. a legacy `{repo}/pr/N` thread, or a free-form thread):
 * those carry no slice work_item, so the projection leaves the anchor unlinked
 * (backward compatible — the no-`response_routing` path is unchanged).
 */
export function parseSliceThread(thread: string | undefined): SliceRef | null {
  if (typeof thread !== "string") return null;
  const m = SLICE_THREAD_RE.exec(thread);
  if (m === null) return null;
  const repo = m[1];
  const rawNumber = m[2];
  if (repo === undefined || rawNumber === undefined) return null;
  const issueNumber = Number(rawNumber);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  return { repo, issueNumber };
}

/**
 * The deterministic MC `work_item` id for a slice's issue. Keyed off the slice
 * address (`github:{repo}/issue/N`), provider-namespaced like the `github:`
 * repo-id convention in `adapters/github/ingest.ts`. Both the slice projection
 * (here) and a per-slice GitHub issue enrichment derive the SAME id from the
 * SAME `{repo}/issue/N` address, so the two converge on ONE row (upsert by id —
 * no duplicate, no parallel entity), satisfying §C2's upsert-by-issue-key.
 */
export function workItemIdForSlice(ref: SliceRef): string {
  return `github:${ref.repo}/issue/${ref.issueNumber}`;
}

/**
 * Resolve the issue's `work_item` for a slice and link the per-dispatch anchor
 * `task` to it (slice convergence C). Idempotent:
 *
 *   - the work_item is LAZY-created by its deterministic id ({@link workItemIdForSlice})
 *     via the existing `upsertWorkItem` — but only when ABSENT. A later GitHub
 *     ingest enriches the SAME row by the same key; we must not clobber a richer
 *     row's `status`/`priority` with empty stub defaults on a redelivery, so we
 *     create-if-absent rather than blind-upsert (the "stub now, enrich later,
 *     never downgrade" rule). The id is the convergence key — one row per issue.
 *   - the anchor task's `work_item_id` is set to that id.
 *
 * Called from the dispatch-lifecycle projection inside its anchor transaction.
 * A no-op for a non-issue / absent thread (the caller passes null).
 */
export function linkAnchorToSliceWorkItem(
  db: Database,
  correlationId: string,
  ref: SliceRef,
): string {
  const workItemId = workItemIdForSlice(ref);

  // Create-if-absent: the stub carries only the identity fields the convergence
  // key implies. If the row already exists (a prior dispatch's stub, OR a GitHub
  // ingest's enriched row), we leave it untouched — reusing `upsertWorkItem`
  // strictly for creation so a redelivery never resets an enriched status/priority
  // to the empty stub defaults.
  if (getWorkItem(db, workItemId) === null) {
    upsertWorkItem(db, {
      id: workItemId,
      planId: null,
      phaseId: null,
      parentId: null,
      title: `${ref.repo}#${ref.issueNumber}`,
      description: null,
      status: "",
      priority: "",
      provider: "github",
      externalId: `${ref.repo}#${ref.issueNumber}`,
      url: null,
    });
  }

  db.query(`UPDATE tasks SET work_item_id = ? WHERE id = ?`).run(
    workItemId,
    anchorTaskId(correlationId),
  );

  return workItemId;
}
