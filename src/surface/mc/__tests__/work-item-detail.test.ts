/**
 * G-1113.D.5 — work-item detail projection (api/work-item-detail.ts).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertPlan, upsertPlanPhase } from "../db/plans";
import { upsertWorkItem } from "../db/work-items";
import { upsertRepository, upsertPullRequest, upsertReview } from "../db/git-objects";
import { getWorkItemDetail, handleGetWorkItemDetail } from "../api/work-item-detail";
import type { Plan, PlanPhase, WorkItem, GitRepository, PullRequest, Review } from "../types";

const plan: Plan = {
  id: "plan-1", title: "Cockpit", kind: "design", sourceDocumentUrl: null,
  provider: "internal", externalId: null, umbrellaWorkItemId: null, status: "active",
};
const phase: PlanPhase = { id: "phase-d", planId: "plan-1", title: "Plan Lineage", order: 3, status: "active" };
const repo: GitRepository = {
  id: "repo-1", provider: "github", owner: "the-metafactory", name: "cortex", url: null, defaultBranch: "main",
};
const wi: WorkItem = {
  id: "the-metafactory/cortex#581", planId: "plan-1", phaseId: "phase-d", parentId: null,
  title: "G-1113.D.4 — Phase detail", description: null, status: "closed", priority: "",
  provider: "github", externalId: "the-metafactory/cortex#581",
  url: "https://github.com/the-metafactory/cortex/issues/581",
};
const pr: PullRequest = {
  id: "pr-588", workItemId: "the-metafactory/cortex#581", repositoryId: "repo-1", provider: "github",
  providerNativeType: "pull_request", externalId: "the-metafactory/cortex#588", numberOrKey: "588",
  title: "D.4 impl", sourceBranch: "feat/d4", targetBranch: "main",
  url: "https://github.com/the-metafactory/cortex/pull/588", state: "merged", reviewState: "approved",
};
const review: Review = {
  id: "rev-1", pullRequestId: "pr-588", reviewer: "sage", state: "approved", provider: "github", url: null,
};

describe("getWorkItemDetail (D.5)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });
  function freshDb() {
    const p = join(tmpdir(), `wid-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("projects work item + plan/phase context + linked PRs with reviews", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase);
    upsertWorkItem(db, wi);
    upsertRepository(db, repo);
    upsertPullRequest(db, pr);
    upsertReview(db, review);

    const detail = getWorkItemDetail(db, "the-metafactory/cortex#581");
    expect(detail?.workItem.title).toBe("G-1113.D.4 — Phase detail");
    expect(detail?.plan?.id).toBe("plan-1");
    expect(detail?.phase?.id).toBe("phase-d");
    expect(detail?.pullRequests).toHaveLength(1);
    expect(detail?.pullRequests[0]?.pullRequest.id).toBe("pr-588");
    expect(detail?.pullRequests[0]?.reviews.map((r) => r.state)).toEqual(["approved"]);
  });

  it("projects multiple PRs; a PR with no reviews → reviews:[] (the D.5 delta)", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase);
    upsertWorkItem(db, wi);
    upsertRepository(db, repo);
    upsertPullRequest(db, pr); // pr-588, has one review
    upsertReview(db, review);
    upsertPullRequest(db, { ...pr, id: "pr-589", numberOrKey: "589", reviewState: "needs_review" }); // no reviews

    const detail = getWorkItemDetail(db, "the-metafactory/cortex#581");
    expect(detail?.pullRequests).toHaveLength(2);
    expect(detail?.pullRequests.find((p) => p.pullRequest.id === "pr-589")?.reviews).toEqual([]);
    expect(detail?.pullRequests.find((p) => p.pullRequest.id === "pr-588")?.reviews).toHaveLength(1);
  });

  it("handler 200 returns the detail envelope", async () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase);
    upsertWorkItem(db, wi);
    const res = handleGetWorkItemDetail(db, "the-metafactory/cortex#581");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workItem: { id: string } };
    expect(body.workItem.id).toBe("the-metafactory/cortex#581");
  });

  it("unphased / unplanned work item → null plan & phase, still projects", () => {
    const db = freshDb();
    upsertWorkItem(db, { ...wi, id: "wi-orphan", planId: null, phaseId: null });
    const detail = getWorkItemDetail(db, "wi-orphan");
    expect(detail?.plan).toBeNull();
    expect(detail?.phase).toBeNull();
    expect(detail?.pullRequests).toEqual([]);
  });

  it("unknown work item → getWorkItemDetail null, handler 404", async () => {
    const db = freshDb();
    expect(getWorkItemDetail(db, "nope")).toBeNull();
    const res = handleGetWorkItemDetail(db, "nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });
});
