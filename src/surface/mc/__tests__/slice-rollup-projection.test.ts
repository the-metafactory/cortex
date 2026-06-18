/**
 * Slice convergence C (cortex#1150 / docs/design-slice-activity-thread.md §C):
 * MC rolls up a slice's per-dispatch activity under the issue's `work_item`.
 *
 * When the dispatch-lifecycle projection ingests an envelope carrying
 * `response_routing.thread = "{repo}/issue/N"`, it:
 *   - upserts the issue's `work_item` (keyed by the deterministic slice id,
 *     provider github) — lazy-creating a stub when absent so a later GitHub
 *     ingest enriches the SAME row by the same key, and
 *   - links the per-dispatch anchor `task` to that work_item (the queryable
 *     `tasks.work_item_id` column),
 * keeping the existing `correlation_id` anchor intact (additive).
 *
 * Coverage axes (per the brief's TDD list):
 *   1. One dispatch with an issue thread → a github work_item for the issue
 *      exists and the anchor task is linked to it.
 *   2. Two dispatches (implement corr-A + review corr-B) for the SAME issue →
 *      both anchor tasks link to the SAME work_item (the slice rollup).
 *   3. A later GitHub-ingest upsert for the same issue → enriches the SAME row
 *      (no duplicate work_item, status/priority preserved, not clobbered).
 *   4. No response_routing → no work_item link (backward compatible).
 *   5. A non-issue thread (e.g. {repo}/pr/N) → no work_item link.
 *   6. A FEDERATED dispatch's anchor links to the work_item too (lifecycle only).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import { upsertWorkItem, getWorkItem } from "../db/work-items";
import { projectDispatchLifecycle } from "../projection/dispatch-lifecycle";
import { workItemIdForSlice } from "../projection/anchor";
import {
  createDispatchTaskStartedEvent,
  createDispatchTaskCompletedEvent,
  type DispatchEventSource,
  type LogicalResponseRouting,
} from "../../../bus/dispatch-events";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

const SOURCE: DispatchEventSource = {
  principal: "andreas",
  agent: "cortex",
  instance: "local",
};

const STARTED_AT = new Date("2026-06-19T12:00:00.000Z");
const COMPLETED_AT = new Date("2026-06-19T12:05:00.000Z");

// Distinct per-dispatch task ids (each dispatch has its own correlation_id).
const TASK_IMPLEMENT = "11111111-1111-4111-8111-111111111111";
const TASK_REVIEW = "22222222-2222-4222-8222-222222222222";

const ISSUE_THREAD = "cortex/issue/872";
const SLICE_REF = { repo: "cortex", issueNumber: 872 };

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

function startedFor(
  taskId: string,
  routing?: LogicalResponseRouting,
): Envelope {
  return createDispatchTaskStartedEvent({
    source: SOURCE,
    taskId,
    agentId: "cortex",
    startedAt: STARTED_AT,
    ...(routing !== undefined && { responseRouting: routing }),
  });
}

function completedFor(
  taskId: string,
  routing?: LogicalResponseRouting,
): Envelope {
  return createDispatchTaskCompletedEvent({
    source: SOURCE,
    taskId,
    agentId: "cortex",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    resultSummary: "done",
    ...(routing !== undefined && { responseRouting: routing }),
  });
}

const logical = (thread: string): LogicalResponseRouting => ({
  surface: "discord",
  channel: "cortex",
  thread,
});

/** The anchor task's work_item_id (the slice link), or null. */
function anchorWorkItemId(db: Database, taskId: string): string | null {
  const row = db
    .query(`SELECT work_item_id FROM tasks WHERE id = ?`)
    .get(`mc-dispatch-task-${taskId}`) as { work_item_id: string | null } | null;
  return row ? row.work_item_id : null;
}

function workItemCount(db: Database): number {
  return (
    db.query(`SELECT COUNT(*) AS n FROM work_items`).get() as { n: number }
  ).n;
}

describe("slice-rollup projection (slice convergence C)", () => {
  let db: Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it("a dispatch with response_routing.thread={repo}/issue/N creates the issue work_item and links the anchor task", () => {
    projectDispatchLifecycle(db, startedFor(TASK_IMPLEMENT, logical(ISSUE_THREAD)));

    const expectedId = workItemIdForSlice(SLICE_REF);
    const wi = getWorkItem(db, expectedId);
    expect(wi).not.toBeNull();
    expect(wi!.provider).toBe("github");
    expect(wi!.externalId).toBe("cortex#872");

    // The per-dispatch anchor task is linked to the issue work_item.
    expect(anchorWorkItemId(db, TASK_IMPLEMENT)).toBe(expectedId);

    // The correlation_id anchor stays intact (additive): the session row exists.
    const sessions = db.query(`SELECT id FROM sessions`).all() as { id: string }[];
    expect(sessions).toHaveLength(1);
  });

  it("two dispatches (implement + review) for the same issue link to the SAME work_item (the slice rollup)", () => {
    // Implement dispatch (corr A) and review dispatch (corr B), same issue.
    projectDispatchLifecycle(db, startedFor(TASK_IMPLEMENT, logical(ISSUE_THREAD)));
    projectDispatchLifecycle(db, startedFor(TASK_REVIEW, logical(ISSUE_THREAD)));

    const sliceId = workItemIdForSlice(SLICE_REF);

    // Both anchor tasks point at the one slice work_item.
    expect(anchorWorkItemId(db, TASK_IMPLEMENT)).toBe(sliceId);
    expect(anchorWorkItemId(db, TASK_REVIEW)).toBe(sliceId);

    // Exactly ONE work_item — the slice, not one per dispatch.
    expect(workItemCount(db)).toBe(1);

    // The slice card gathers its dispatches: query the anchor tasks by work_item.
    const rolledUp = db
      .query(`SELECT id FROM tasks WHERE work_item_id = ? ORDER BY id`)
      .all(sliceId) as { id: string }[];
    expect(rolledUp.map((r) => r.id)).toEqual([
      `mc-dispatch-task-${TASK_IMPLEMENT}`,
      `mc-dispatch-task-${TASK_REVIEW}`,
    ]);
  });

  it("a later GitHub-ingest upsert for the same issue enriches the SAME row (no duplicate, status preserved)", () => {
    // Slice projection lazy-creates the stub.
    projectDispatchLifecycle(db, startedFor(TASK_IMPLEMENT, logical(ISSUE_THREAD)));
    const sliceId = workItemIdForSlice(SLICE_REF);
    expect(workItemCount(db)).toBe(1);

    // A GitHub ingest enriches the SAME row by the same key (title, status, url).
    upsertWorkItem(db, {
      id: sliceId,
      planId: null,
      phaseId: null,
      parentId: null,
      title: "Slice convergence C — MC slice-rollup",
      description: "the real issue title",
      status: "open",
      priority: "now",
      provider: "github",
      externalId: "cortex#872",
      url: "https://github.com/the-metafactory/cortex/issues/872",
    });

    // Still ONE row — no parallel entity.
    expect(workItemCount(db)).toBe(1);
    const enriched = getWorkItem(db, sliceId)!;
    expect(enriched.title).toBe("Slice convergence C — MC slice-rollup");
    expect(enriched.status).toBe("open");
    expect(enriched.url).toBe(
      "https://github.com/the-metafactory/cortex/issues/872",
    );

    // A REDELIVERED slice dispatch must NOT clobber the enriched fields back to
    // the empty stub defaults (create-if-absent, never downgrade).
    projectDispatchLifecycle(db, completedFor(TASK_IMPLEMENT, logical(ISSUE_THREAD)));
    const afterRedeliver = getWorkItem(db, sliceId)!;
    expect(afterRedeliver.status).toBe("open");
    expect(afterRedeliver.title).toBe("Slice convergence C — MC slice-rollup");
    expect(workItemCount(db)).toBe(1);
    // The anchor link still holds.
    expect(anchorWorkItemId(db, TASK_IMPLEMENT)).toBe(sliceId);
  });

  it("no response_routing → no work_item link (backward compatible)", () => {
    projectDispatchLifecycle(db, startedFor(TASK_IMPLEMENT));
    expect(workItemCount(db)).toBe(0);
    expect(anchorWorkItemId(db, TASK_IMPLEMENT)).toBeNull();
  });

  it("a non-issue thread ({repo}/pr/N) → no work_item link", () => {
    projectDispatchLifecycle(db, startedFor(TASK_IMPLEMENT, logical("cortex/pr/57")));
    expect(workItemCount(db)).toBe(0);
    expect(anchorWorkItemId(db, TASK_IMPLEMENT)).toBeNull();
  });

  it("a federated dispatch's anchor links to the work_item too (lifecycle only, no special-case)", () => {
    // A federated review dispatch carries the SAME slice address; only its
    // terminal verdict lands (no interior projected from a peer). The anchor
    // still links to the slice work_item exactly like a local dispatch.
    projectDispatchLifecycle(db, completedFor(TASK_REVIEW, logical(ISSUE_THREAD)));
    const sliceId = workItemIdForSlice(SLICE_REF);
    expect(anchorWorkItemId(db, TASK_REVIEW)).toBe(sliceId);
    expect(workItemCount(db)).toBe(1);
  });
});
