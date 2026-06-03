/**
 * G-1113.E.3 — attention queue projection (api/attention.ts): deep-link resolution.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertPlan, upsertPlanPhase } from "../db/plans";
import { upsertWorkItem } from "../db/work-items";
import { upsertAttentionItem } from "../db/attention";
import { getAttentionQueue, handleListAttention } from "../api/attention";
import type { AttentionItem, Plan, PlanPhase, WorkItem } from "../types";

const plan: Plan = {
  id: "plan-1", title: "P", kind: "design", sourceDocumentUrl: null,
  provider: "internal", externalId: null, umbrellaWorkItemId: null, status: "active",
};
const phase: PlanPhase = { id: "phase-a", planId: "plan-1", title: "A", order: 0, status: "active" };
const wi: WorkItem = {
  id: "wi-1", planId: "plan-1", phaseId: "phase-a", parentId: null, title: "Fix the thing",
  description: null, status: "open", priority: "", provider: "github", externalId: "o/r#1", url: null,
};
const att = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "att-x", stackId: "laptop", workItemId: null, sessionId: null,
  kind: "blocked", severity: "normal", status: "open", ...over,
});

describe("getAttentionQueue (E.3)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });
  function freshDb() {
    const p = join(tmpdir(), `attq-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }
  function seedSession(db: ReturnType<typeof initDatabase>): string {
    db.query(`INSERT INTO agents (id, name, type) VALUES ('ag-1', 'Echo', 'head')`).run();
    db.query(`INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('tk-1', 'T', 'andreas', 'github', 'open')`).run();
    db.query(`INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('asg-1', 'ag-1', 'tk-1', 'running')`).run();
    db.query(`INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('sess-1', 'asg-1', 'local.observed')`).run();
    return "sess-1";
  }

  it("resolves a work-item link to its title (→ work-item-detail route)", () => {
    const db = freshDb();
    upsertPlan(db, plan); upsertPlanPhase(db, phase); upsertWorkItem(db, wi);
    upsertAttentionItem(db, att({ id: "att-wi", workItemId: "wi-1", kind: "stale", severity: "low" }));
    const [entry] = getAttentionQueue(db);
    expect(entry?.item.id).toBe("att-wi");
    expect(entry?.link).toEqual({ kind: "work-item", workItemId: "wi-1", label: "Fix the thing" });
  });

  it("resolves a session link to its assignment id (→ drill-down route)", () => {
    const db = freshDb();
    const sessionId = seedSession(db);
    upsertAttentionItem(db, att({ id: "att-sess", sessionId, kind: "permission", severity: "high" }));
    const [entry] = getAttentionQueue(db);
    expect(entry?.link).toEqual({ kind: "session", sessionId: "sess-1", assignmentId: "asg-1" });
  });

  it("lists only open items, severity-ordered (resolved excluded)", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase);
    upsertWorkItem(db, wi); // wi-1
    upsertWorkItem(db, { ...wi, id: "wi-2", title: "Other" });
    // work_item_id is an FK with ON DELETE SET NULL, so a link is always either
    // a real work item or NULL — a dangling ref can't exist, so resolveLink's
    // id-fallback is defensively unreachable; we test with real work items.
    upsertAttentionItem(db, att({ id: "att-low", workItemId: "wi-2", kind: "stale", severity: "low" }));
    upsertAttentionItem(db, att({ id: "att-crit", workItemId: "wi-1", kind: "blocked", severity: "critical" }));
    upsertAttentionItem(db, att({ id: "att-done", workItemId: "wi-1", severity: "critical", status: "resolved" }));
    const q = getAttentionQueue(db);
    expect(q.map((e) => e.item.id)).toEqual(["att-crit", "att-low"]); // severity order, resolved excluded
    expect(q[0]?.link).toEqual({ kind: "work-item", workItemId: "wi-1", label: "Fix the thing" });
  });

  it("handleListAttention returns a { attention } envelope (200 + JSON)", async () => {
    const db = freshDb();
    upsertPlan(db, plan); upsertPlanPhase(db, phase); upsertWorkItem(db, wi);
    upsertAttentionItem(db, att({ id: "att-wi", workItemId: "wi-1" }));
    const res = handleListAttention(db);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { attention: { item: { id: string } }[] };
    expect(body.attention[0]?.item.id).toBe("att-wi");
  });
});
