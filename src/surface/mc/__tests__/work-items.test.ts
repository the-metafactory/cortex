/**
 * G-1113.D.4 — WorkItem storage round-trip + phase-detail projection.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertPlan, upsertPlanPhase } from "../db/plans";
import {
  upsertWorkItem,
  getWorkItem,
  listWorkItemsForPhase,
  listWorkItemsForPlan,
} from "../db/work-items";
import { upsertRepository, upsertPullRequest } from "../db/git-objects";
import { getPhaseDetail, handleGetPhaseDetail } from "../api/phase-detail";
import type { Plan, PlanPhase, WorkItem, GitRepository, PullRequest } from "../types";

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
const phaseA: PlanPhase = { id: "phase-a", planId: "plan-1", title: "A", order: 0, status: "active" };
const phaseB: PlanPhase = { id: "phase-b", planId: "plan-1", title: "B", order: 1, status: "not_started" };

const wi = (over: Partial<WorkItem>): WorkItem => ({
  id: "wi-1",
  planId: "plan-1",
  phaseId: "phase-a",
  parentId: null,
  title: "Work item",
  description: null,
  status: "open",
  priority: "1",
  provider: "github",
  externalId: "the-metafactory/cortex#42",
  url: "https://github.com/the-metafactory/cortex/issues/42",
  ...over,
});

describe("work-items storage (D.4)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `wi-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("round-trips a work item + idempotent update; nullable plan/phase/parent", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    const item = wi({});
    upsertWorkItem(db, item);
    expect(getWorkItem(db, "wi-1")).toEqual(item);
    upsertWorkItem(db, { ...item, status: "done" });
    expect(getWorkItem(db, "wi-1")?.status).toBe("done");
    // Fully-unlinked work item (no plan/phase/parent) is valid.
    const orphan = wi({ id: "wi-x", planId: null, phaseId: null, parentId: null });
    upsertWorkItem(db, orphan);
    expect(getWorkItem(db, "wi-x")).toEqual(orphan);
  });

  it("lists by phase (priority,title ordered) and by plan; unknown id → null", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    upsertPlanPhase(db, phaseB);
    upsertWorkItem(db, wi({ id: "wi-2", phaseId: "phase-a", priority: "2", title: "beta" }));
    upsertWorkItem(db, wi({ id: "wi-1", phaseId: "phase-a", priority: "1", title: "alpha" }));
    upsertWorkItem(db, wi({ id: "wi-3", phaseId: "phase-b", priority: "1", title: "gamma" }));
    expect(listWorkItemsForPhase(db, "phase-a").map((w) => w.id)).toEqual(["wi-1", "wi-2"]);
    expect(listWorkItemsForPhase(db, "phase-b").map((w) => w.id)).toEqual(["wi-3"]);
    expect(listWorkItemsForPlan(db, "plan-1").map((w) => w.id)).toEqual(["wi-1", "wi-3", "wi-2"]);
    expect(getWorkItem(db, "nope")).toBeNull();
  });

  it("FK enforced: ghost phase_id / plan_id / parent_id throw", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    expect(() => upsertWorkItem(db, wi({ phaseId: "ghost" }))).toThrow();
    expect(() => upsertWorkItem(db, wi({ planId: "ghost" }))).toThrow();
    expect(() => upsertWorkItem(db, wi({ parentId: "ghost" }))).toThrow();
  });

  it("self-ref parent FK satisfied: child links to a parent work item", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    // Insert order is load-bearing under FK enforcement: parent before child.
    upsertWorkItem(db, wi({ id: "wi-parent", parentId: null, title: "parent" }));
    upsertWorkItem(db, wi({ id: "wi-child", parentId: "wi-parent", title: "child" }));
    expect(getWorkItem(db, "wi-child")?.parentId).toBe("wi-parent");
    expect(listWorkItemsForPhase(db, "phase-a").map((w) => w.id)).toEqual(["wi-child", "wi-parent"]);
  });

  it("phase ordering is lexicographic by priority (spec: priority is a string)", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    upsertWorkItem(db, wi({ id: "wi-10", priority: "10", title: "ten" }));
    upsertWorkItem(db, wi({ id: "wi-2", priority: "2", title: "two" }));
    // '10' < '2' lexicographically — locks the documented (§6 string-priority) behaviour.
    expect(listWorkItemsForPhase(db, "phase-a").map((w) => w.id)).toEqual(["wi-10", "wi-2"]);
  });
});

describe("getPhaseDetail / handleGetPhaseDetail (D.4)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `pd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("projects phase + plan + work items, each with linked PRs", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    upsertWorkItem(db, wi({ id: "wi-1", phaseId: "phase-a" }));

    const repo: GitRepository = {
      id: "repo-1",
      provider: "github",
      owner: "the-metafactory",
      name: "cortex",
      url: null,
      defaultBranch: "main",
    };
    upsertRepository(db, repo);
    const pr: PullRequest = {
      id: "pr-1",
      workItemId: "wi-1",
      repositoryId: "repo-1",
      provider: "github",
      providerNativeType: "pull_request",
      externalId: "the-metafactory/cortex#42",
      numberOrKey: "42",
      title: "Implement wi-1",
      sourceBranch: "feat/x",
      targetBranch: "main",
      url: "https://github.com/the-metafactory/cortex/pull/42",
      state: "open",
      reviewState: "needs_review",
    };
    upsertPullRequest(db, pr);

    const detail = getPhaseDetail(db, "phase-a");
    expect(detail?.phase.id).toBe("phase-a");
    expect(detail?.plan?.id).toBe("plan-1");
    expect(detail?.workItems).toHaveLength(1);
    expect(detail?.workItems[0]?.workItem.id).toBe("wi-1");
    expect(detail?.workItems[0]?.pullRequests.map((p) => p.id)).toEqual(["pr-1"]);
  });

  it("phase with no work items projects an empty list (honest empty state)", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseA);
    const detail = getPhaseDetail(db, "phase-a");
    expect(detail?.workItems).toEqual([]);
    expect(detail?.plan?.id).toBe("plan-1");
  });

  it("unknown phase → getPhaseDetail null, handler 404", async () => {
    const db = freshDb();
    expect(getPhaseDetail(db, "nope")).toBeNull();
    const res = handleGetPhaseDetail(db, "nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });
});
