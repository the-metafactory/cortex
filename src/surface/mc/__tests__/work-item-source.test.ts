/**
 * G-1113.D.5b — provider-neutral ingestion orchestrator (adapters/work-item-source.ts).
 * Proven with a mock source — the orchestrator knows nothing about GitHub.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertPlan, upsertPlanPhase } from "../db/plans";
import { getWorkItem, listWorkItemsForPlan } from "../db/work-items";
import { ingestWorkItems, type WorkItemSource } from "../adapters/work-item-source";
import type { Plan, WorkItem } from "../types";

const plan: Plan = {
  id: "plan-1",
  title: "Cockpit",
  kind: "design",
  sourceDocumentUrl: null,
  provider: "internal",
  externalId: null,
  umbrellaWorkItemId: null,
  status: "active",
};

/** A source that returns canned rows and records the context it was given. */
function mockSource(items: WorkItem[]): WorkItemSource & { seen: { planId?: string; phaseCount?: number } } {
  const seen: { planId?: string; phaseCount?: number } = {};
  return {
    provider: "custom",
    seen,
    async fetchWorkItems(ctx) {
      seen.planId = ctx.plan.id;
      seen.phaseCount = ctx.phases.length;
      return items;
    },
  };
}

const wi = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  planId: "plan-1",
  phaseId: null,
  parentId: null,
  title: id,
  description: null,
  status: "open",
  priority: "",
  provider: "custom",
  externalId: id,
  url: null,
  ...over,
});

describe("ingestWorkItems (D.5b orchestrator)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `wis-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("persists the source's rows + passes plan & phases to the source", async () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, { id: "plan-1-phase-a", planId: "plan-1", title: "A", order: 0, status: "active" });
    const src = mockSource([wi("a#1"), wi("a#2")]);
    const res = await ingestWorkItems(db, src, "plan-1");
    expect(res.workItems).toHaveLength(2);
    expect(getWorkItem(db, "a#1")?.title).toBe("a#1");
    expect(listWorkItemsForPlan(db, "plan-1")).toHaveLength(2);
    // The orchestrator handed the source the plan + its phases.
    expect(src.seen.planId).toBe("plan-1");
    expect(src.seen.phaseCount).toBe(1);
  });

  it("is idempotent — re-ingesting the same rows updates in place", async () => {
    const db = freshDb();
    upsertPlan(db, plan);
    await ingestWorkItems(db, mockSource([wi("a#1", { status: "open" })]), "plan-1");
    await ingestWorkItems(db, mockSource([wi("a#1", { status: "closed" })]), "plan-1");
    expect(listWorkItemsForPlan(db, "plan-1")).toHaveLength(1);
    expect(getWorkItem(db, "a#1")?.status).toBe("closed");
  });

  it("unknown plan → empty result, persists nothing", async () => {
    const db = freshDb();
    const res = await ingestWorkItems(db, mockSource([wi("a#1")]), "ghost");
    expect(res.workItems).toEqual([]);
    expect(getWorkItem(db, "a#1")).toBeNull();
  });

  it("empty source → no rows", async () => {
    const db = freshDb();
    upsertPlan(db, plan);
    const res = await ingestWorkItems(db, mockSource([]), "plan-1");
    expect(res.workItems).toEqual([]);
    expect(listWorkItemsForPlan(db, "plan-1")).toEqual([]);
  });

  it("is all-or-nothing — a mid-batch upsert failure rolls back the whole transaction", async () => {
    const db = freshDb();
    upsertPlan(db, plan);
    // Second row has a ghost phaseId → its upsert violates the phase FK and throws.
    const src = mockSource([wi("a#1"), wi("a#2", { phaseId: "ghost-phase" })]);
    await expect(ingestWorkItems(db, src, "plan-1")).rejects.toThrow();
    // a#1 must NOT have persisted — the transaction rolled back, not a partial write.
    expect(listWorkItemsForPlan(db, "plan-1")).toEqual([]);
  });
});
