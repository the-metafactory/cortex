/**
 * G-1113.E.1 — AttentionItem storage round-trip + lifecycle + FK behaviour.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertPlan, upsertPlanPhase } from "../db/plans";
import { upsertWorkItem } from "../db/work-items";
import {
  upsertAttentionItem,
  getAttentionItem,
  listOpenAttention,
  resolveAttentionItem,
  dismissAttentionItem,
} from "../db/attention";
import type { AttentionItem, Plan, PlanPhase, WorkItem } from "../types";

const plan: Plan = {
  id: "plan-1", title: "P", kind: "design", sourceDocumentUrl: null,
  provider: "internal", externalId: null, umbrellaWorkItemId: null, status: "active",
};
const phase: PlanPhase = { id: "phase-a", planId: "plan-1", title: "A", order: 0, status: "active" };
const wi: WorkItem = {
  id: "wi-1", planId: "plan-1", phaseId: "phase-a", parentId: null, title: "WI",
  description: null, status: "open", priority: "", provider: "github",
  externalId: "o/r#1", url: null,
};
const att = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "att-1",
  stackId: "laptop",
  workItemId: "wi-1",
  sessionId: null,
  kind: "blocked",
  severity: "normal",
  status: "open",
  ...over,
});

describe("attention storage (E.1)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });
  function freshDb() {
    const p = join(tmpdir(), `att-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }
  function seed(db: ReturnType<typeof initDatabase>) {
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase);
    upsertWorkItem(db, wi);
  }
  /** Seed the agents→tasks→assignment→sessions FK chain; returns the session id. */
  function seedSession(db: ReturnType<typeof initDatabase>): string {
    db.query(`INSERT INTO agents (id, name, type) VALUES ('ag-1', 'Echo', 'head')`).run();
    db.query(
      `INSERT INTO tasks (id, title, principal_id, source_system, status) VALUES ('tk-1', 'T', 'andreas', 'github', 'open')`
    ).run();
    db.query(
      `INSERT INTO agent_task_assignment (id, agent_id, task_id, state) VALUES ('asg-1', 'ag-1', 'tk-1', 'running')`
    ).run();
    db.query(
      `INSERT INTO sessions (id, assignment_id, endpoint_kind) VALUES ('sess-1', 'asg-1', 'local.observed')`
    ).run();
    return "sess-1";
  }

  it("round-trips an item + idempotent upsert overwrites every mutable column", () => {
    const db = freshDb();
    seed(db);
    const item = att({});
    upsertAttentionItem(db, item);
    expect(getAttentionItem(db, "att-1")).toEqual(item);
    expect(getAttentionItem(db, "nope")).toBeNull();
    // Re-upsert the SAME id with a fully different record — proves the ON
    // CONFLICT clause overwrites every mutable column (not just one).
    const changed = att({
      id: "att-1",
      stackId: "clawbox",
      workItemId: null,
      sessionId: null,
      kind: "review",
      severity: "high",
      status: "resolved",
    });
    upsertAttentionItem(db, changed);
    expect(getAttentionItem(db, "att-1")).toEqual(changed);
  });

  it("CHECK rejects out-of-vocabulary kind / severity / status", () => {
    const db = freshDb();
    seed(db);
    expect(() => upsertAttentionItem(db, att({ kind: "bogus" as AttentionItem["kind"] }))).toThrow();
    expect(() => upsertAttentionItem(db, att({ severity: "bogus" as AttentionItem["severity"] }))).toThrow();
    expect(() => upsertAttentionItem(db, att({ status: "bogus" as AttentionItem["status"] }))).toThrow();
  });

  it("listOpenAttention returns open only, ordered by severity then age", () => {
    const db = freshDb();
    seed(db);
    upsertAttentionItem(db, att({ id: "a-normal", severity: "normal" }));
    upsertAttentionItem(db, att({ id: "a-critical", severity: "critical" }));
    upsertAttentionItem(db, att({ id: "a-low", severity: "low" }));
    upsertAttentionItem(db, att({ id: "a-resolved", severity: "critical", status: "resolved" }));
    expect(listOpenAttention(db).map((i) => i.id)).toEqual(["a-critical", "a-normal", "a-low"]);
  });

  it("resolve / dismiss transition status and drop the item from the open queue", () => {
    const db = freshDb();
    seed(db);
    upsertAttentionItem(db, att({ id: "a-1" }));
    upsertAttentionItem(db, att({ id: "a-2" }));
    expect(resolveAttentionItem(db, "a-1")).toBe(true);
    expect(getAttentionItem(db, "a-1")?.status).toBe("resolved");
    expect(dismissAttentionItem(db, "a-2")).toBe(true);
    expect(getAttentionItem(db, "a-2")?.status).toBe("dismissed");
    expect(listOpenAttention(db)).toEqual([]);
    // transitioning an unknown id is a no-op (no row changed).
    expect(resolveAttentionItem(db, "ghost")).toBe(false);
  });

  it("FK SET NULL: deleting the linked work item clears the link, keeps the item", () => {
    const db = freshDb();
    seed(db);
    upsertAttentionItem(db, att({ id: "a-1", workItemId: "wi-1" }));
    // Deleting the work item must NOT be blocked (SET NULL, not RESTRICT) and
    // must leave the attention item intact with a null link.
    db.query(`DELETE FROM work_items WHERE id = 'wi-1'`).run();
    const item = getAttentionItem(db, "a-1");
    expect(item).not.toBeNull();
    expect(item?.workItemId).toBeNull();
  });

  it("FK SET NULL: deleting the linked session clears session_id, keeps the item", () => {
    const db = freshDb();
    seed(db);
    const sessionId = seedSession(db);
    // The session is the PRIMARY link for this 'blocked' item (no work item).
    upsertAttentionItem(db, att({ id: "a-1", workItemId: null, sessionId, kind: "blocked" }));
    // Sessions cascade-delete with their assignment in production — deleting the
    // session must clear the link (SET NULL), not block the delete or drop the item.
    db.query(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    const item = getAttentionItem(db, "a-1");
    expect(item).not.toBeNull();
    expect(item?.sessionId).toBeNull();
  });
});
