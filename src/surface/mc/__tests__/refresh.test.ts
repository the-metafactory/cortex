/**
 * ML.2 — cockpit refresh orchestrator: the full live chain end-to-end
 * (plan docs → plans/phases → provider-dispatched work items → attention).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { getPlan, listPlans } from "../db/plans";
import { getWorkItem, listWorkItemsForPlan } from "../db/work-items";
import { listOpenAttention } from "../db/attention";
import { refreshCockpit, defaultWorkItemSourceFor, type WorkItemSourceFactory } from "../refresh";
import { GithubWorkItemSource } from "../adapters/github/work-items";
import type { WorkItemSource } from "../adapters/work-item-source";
import type { WorkItem } from "../types";

const NOW = 1_900_000_000;
const DAY = 24 * 60 * 60;

// A plan doc whose umbrella ref makes it a github plan (ML.1 → provider github).
const GH_PLAN = `# Cockpit\n\n**Status:** active\n**Umbrella issue:** the-metafactory/cortex#354\n\n## Phase A — Grounding\n`;
// A plan doc with no umbrella → internal provider (no work-item source).
const INTERNAL_PLAN = `# Internal plan\n\n**Status:** active\n\n## Phase A — X\n`;

/** A mock github source returning N canned work items for the plan's first phase. */
function mockFactory(itemsByPlan: Record<string, WorkItem[]>): WorkItemSourceFactory {
  return (provider) =>
    provider === "github"
      ? ({
          provider: "github",
          fetchWorkItems: async (ctx) => itemsByPlan[ctx.plan.id] ?? [],
        } satisfies WorkItemSource)
      : null;
}

describe("refreshCockpit (ML.2)", () => {
  const dbPaths: string[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const p of dbPaths) if (existsSync(p)) rmSync(p);
    for (const d of dirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    dbPaths.length = 0;
    dirs.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `refresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbPaths.push(p);
    return initDatabase(p);
  }
  function docsDir(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "refresh-docs-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  it("runs the full chain: docs → plans → provider-dispatched work items → attention", async () => {
    const db = freshDb();
    const dir = docsDir({ "plan-cockpit.md": GH_PLAN, "iteration-internal.md": INTERNAL_PLAN });

    // Pre-seed a stale work item so the reconcile step (3) has something to flag.
    db.query(
      `INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi-stale', 'old', 'open', '', 'github', ?)`
    ).run(NOW - 30 * DAY);

    const wi: WorkItem = {
      id: "the-metafactory/cortex#581", planId: "plan-cockpit", phaseId: "plan-cockpit-phase-a",
      parentId: null, title: "G-1113.D.4", description: null, status: "open", priority: "",
      provider: "github", externalId: "the-metafactory/cortex#581", url: "https://x/581",
    };
    const res = await refreshCockpit(db, {
      docsDir: dir,
      stackId: "laptop",
      nowEpochSec: NOW,
      workItemSourceFor: mockFactory({ "plan-cockpit": [wi] }),
    });

    // Plans: both docs ingested; the github one provider=github, internal one internal.
    expect(res.plans).toBe(2);
    expect(getPlan(db, "plan-cockpit")?.provider).toBe("github");
    expect(getPlan(db, "iteration-internal")?.provider).toBe("internal");
    // Work items: ingested for the github plan; the internal plan has no source.
    expect(res.workItems).toBe(1);
    expect(res.unsupportedProviders).toBe(1); // the internal plan
    expect(getWorkItem(db, "the-metafactory/cortex#581")?.phaseId).toBe("plan-cockpit-phase-a");
    expect(listWorkItemsForPlan(db, "plan-cockpit")).toHaveLength(1);
    // Attention reconcile ran: the pre-seeded stale work item is now flagged.
    expect(res.attentionOpen).toBeGreaterThanOrEqual(1);
    expect(listOpenAttention(db).some((a) => a.id === "att:stale:wi-stale")).toBe(true);
  });

  it("is idempotent — a second refresh yields the same populated state", async () => {
    const db = freshDb();
    const dir = docsDir({ "plan-cockpit.md": GH_PLAN });
    const wi: WorkItem = {
      id: "o/r#1", planId: "plan-cockpit", phaseId: null, parentId: null, title: "WI",
      description: null, status: "open", priority: "", provider: "github", externalId: "o/r#1", url: null,
    };
    const opts = { docsDir: dir, stackId: "laptop", nowEpochSec: NOW, workItemSourceFor: mockFactory({ "plan-cockpit": [wi] }) };
    await refreshCockpit(db, opts);
    const second = await refreshCockpit(db, opts);
    expect(second.plans).toBe(1);
    expect(second.workItems).toBe(1);
    expect(listPlans(db)).toHaveLength(1);
    expect(listWorkItemsForPlan(db, "plan-cockpit")).toHaveLength(1);
  });

  it("a github plan with a null umbrella dispatches the source but ingests nothing (honest no-op)", async () => {
    const db = freshDb();
    // No **Umbrella** line → provider stays internal → no github source. To exercise
    // a github plan whose source returns [] (null-umbrella no-op), inject a source
    // that returns [] and a doc whose umbrella makes it github.
    const dir = docsDir({ "plan-cockpit.md": GH_PLAN });
    const res = await refreshCockpit(db, {
      docsDir: dir, stackId: "laptop", nowEpochSec: NOW,
      workItemSourceFor: mockFactory({}), // github source returns [] for this plan
    });
    expect(res.plans).toBe(1);
    expect(res.workItems).toBe(0);
    expect(res.unsupportedProviders).toBe(0); // a source WAS dispatched, it just had nothing
    expect(res.failedPlans).toBe(0);
    expect(listWorkItemsForPlan(db, "plan-cockpit")).toEqual([]);
  });

  it("isolates a throwing source: the batch continues + reconcile still runs", async () => {
    const db = freshDb();
    const dir = docsDir({ "plan-cockpit.md": GH_PLAN });
    db.query(
      `INSERT INTO work_items (id, title, status, priority, provider, updated_at) VALUES ('wi-stale', 'old', 'open', '', 'github', ?)`
    ).run(NOW - 30 * DAY);
    const throwingFactory: WorkItemSourceFactory = (provider) =>
      provider === "github"
        ? ({ provider: "github", fetchWorkItems: async () => { throw new Error("gh boom"); } } satisfies WorkItemSource)
        : null;
    const res = await refreshCockpit(db, {
      docsDir: dir, stackId: "laptop", nowEpochSec: NOW, workItemSourceFor: throwingFactory,
    });
    expect(res.failedPlans).toBe(1); // the throw was isolated, not propagated
    expect(res.workItems).toBe(0);
    // reconcile still ran despite the failed plan — the stale item is flagged.
    expect(res.attentionOpen).toBeGreaterThanOrEqual(1);
    expect(listOpenAttention(db).some((a) => a.id === "att:stale:wi-stale")).toBe(true);
  });

  it("defaultWorkItemSourceFor dispatches github → GithubWorkItemSource, others → null", () => {
    expect(defaultWorkItemSourceFor("github")).toBeInstanceOf(GithubWorkItemSource);
    expect(defaultWorkItemSourceFor("gitlab")).toBeNull();
    expect(defaultWorkItemSourceFor("internal")).toBeNull();
  });
});
