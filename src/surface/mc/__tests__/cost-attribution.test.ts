/**
 * SES-1 / #1709 / decision D-16 — unit tests for the per-session token/cost +
 * attribution read model (db/cost-attribution.ts).
 *
 * Pins:
 *   - per-session projection of the EXISTING usage columns (input/output/cache
 *     tokens + cost) into the cost row, NULL usage reading as an honest 0;
 *   - SUB-AGENT rollup: a session's rolledUp total includes every descendant's
 *     spend, folded up the parent_session_id edge (multi-level + siblings);
 *   - forPrincipal comes from the session identity (principal_id, then
 *     home_principal), NEVER inferred; a row with neither is null;
 *   - attribution_target NULL renders as `unattributed`, NEVER a principal/project;
 *   - a child whose parent is out-of-set is emitted as its own row (never dropped);
 *   - cycle safety (a→b→a self/loop edges never hang the rollup);
 *   - OWN-LOCAL guard: the model is a local projection — this test also documents
 *     that the read model is NOT wired into the public DashboardSnapshot (that
 *     boundary carries CK-4a metadata only; see the file header + the
 *     dashboard-snapshot-contract test's attribution_target note).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync } from "fs";

import { initDatabase } from "../db/init";
import {
  listSessionCostAttribution,
  UNATTRIBUTED,
  type SessionCostRow,
} from "../db/cost-attribution";

function seedAgent(db: Database, id: string): void {
  db.query(`INSERT OR IGNORE INTO agents (id, name, type) VALUES (?, ?, 'hands')`).run(
    id,
    `Agent ${id}`
  );
}

function seedTask(db: Database, id: string): void {
  db.query(
    `INSERT OR IGNORE INTO tasks (id, title, priority, principal_id, source_system)
     VALUES (?, ?, 2, 'andreas', 'internal')`
  ).run(id, `Task ${id}`);
}

function seedAssignment(db: Database, id: string, agentId: string, taskId: string): void {
  db.query(
    `INSERT INTO agent_task_assignment (id, agent_id, task_id, state)
     VALUES (?, ?, ?, 'running')`
  ).run(id, agentId, taskId);
}

interface SessionOpts {
  id: string;
  assignmentId: string;
  parentSessionId?: string | null;
  principalId?: string | null;
  homePrincipal?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  attributionTarget?: string | null;
  substrate?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  costUsd?: number | null;
}

function seedSession(db: Database, o: SessionOpts): void {
  db.query(
    `INSERT INTO sessions
       (id, assignment_id, endpoint_kind, started_at,
        parent_session_id, substrate, agent_id, agent_name, principal_id,
        home_principal, attribution_target,
        input_tokens, output_tokens, cache_read_tokens, cost_usd)
     VALUES (?, ?, 'local.process.controlled', datetime('now'),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.id,
    o.assignmentId,
    o.parentSessionId ?? null,
    o.substrate ?? "claude-code",
    o.agentId ?? null,
    o.agentName ?? null,
    o.principalId ?? null,
    o.homePrincipal ?? null,
    o.attributionTarget ?? null,
    o.inputTokens ?? null,
    o.outputTokens ?? null,
    o.cacheReadTokens ?? null,
    o.costUsd ?? null
  );
}

function byId(rows: SessionCostRow[]): Map<string, SessionCostRow> {
  return new Map(rows.map((r) => [r.sessionId, r]));
}

describe("listSessionCostAttribution", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mc-ses1-cost-${Date.now()}-${Math.random()}`);
    db = initDatabase(join(tmpDir, "test.db"));
    seedAgent(db, "ag");
    seedTask(db, "t");
  });
  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when there are no sessions", () => {
    expect(listSessionCostAttribution(db)).toEqual([]);
  });

  it("projects the existing usage columns per session", () => {
    seedAssignment(db, "a1", "ag", "t");
    seedSession(db, {
      id: "s1",
      assignmentId: "a1",
      principalId: "andreas",
      agentId: "ag",
      agentName: "Marcus",
      attributionTarget: "the-metafactory/cortex",
      substrate: "claude-code",
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 30,
      costUsd: 0.42,
    });

    const rows = listSessionCostAttribution(db);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.sessionId).toBe("s1");
    expect(r.agentId).toBe("ag");
    expect(r.agentName).toBe("Marcus");
    expect(r.forPrincipal).toBe("andreas");
    expect(r.attributionTarget).toBe("the-metafactory/cortex");
    expect(r.substrate).toBe("claude-code");
    expect(r.isSubAgent).toBe(false);
    expect(r.own).toEqual({ tokensIn: 120, tokensOut: 45, cacheRead: 30, cost: 0.42 });
    // A leaf's rolledUp equals its own.
    expect(r.rolledUp).toEqual(r.own);
  });

  it("reads NULL usage columns as an honest 0, never a fabricated estimate", () => {
    seedAssignment(db, "a1", "ag", "t");
    seedSession(db, { id: "s1", assignmentId: "a1", principalId: "andreas" });

    const r = listSessionCostAttribution(db)[0]!;
    expect(r.own).toEqual({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cost: 0 });
    expect(r.rolledUp).toEqual({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cost: 0 });
  });

  it("renders unattributed (never a principal) when attribution_target is NULL", () => {
    seedAssignment(db, "a1", "ag", "t");
    seedSession(db, { id: "s1", assignmentId: "a1", principalId: "andreas", attributionTarget: null });

    const r = listSessionCostAttribution(db)[0]!;
    expect(r.attributionTarget).toBe(UNATTRIBUTED);
    expect(r.attributionTarget).toBe("unattributed");
    // The honest bucket is NOT the principal — attribution and identity stay distinct.
    expect(r.attributionTarget).not.toBe(r.forPrincipal);
  });

  it("takes forPrincipal from principal_id, then home_principal, never inferred", () => {
    seedAssignment(db, "a1", "ag", "t");
    seedAssignment(db, "a2", "ag", "t");
    seedAssignment(db, "a3", "ag", "t");
    // principal_id present → used directly
    seedSession(db, { id: "s-pid", assignmentId: "a1", principalId: "andreas", homePrincipal: "jc" });
    // principal_id NULL, home_principal present → falls back to home_principal
    seedSession(db, { id: "s-home", assignmentId: "a2", principalId: null, homePrincipal: "jc" });
    // neither → null (honest, never fabricated from repo/attribution)
    seedSession(db, {
      id: "s-none",
      assignmentId: "a3",
      principalId: null,
      homePrincipal: null,
      attributionTarget: "the-metafactory/cortex",
    });

    const m = byId(listSessionCostAttribution(db));
    expect(m.get("s-pid")!.forPrincipal).toBe("andreas");
    expect(m.get("s-home")!.forPrincipal).toBe("jc");
    expect(m.get("s-none")!.forPrincipal).toBeNull();
    // attribution present but principal absent — the two are independent.
    expect(m.get("s-none")!.attributionTarget).toBe("the-metafactory/cortex");
  });

  it("rolls a sub-agent's spend UP to its initiating parent", () => {
    seedAssignment(db, "a-root", "ag", "t");
    seedAssignment(db, "a-child", "ag", "t");
    seedSession(db, {
      id: "s-root",
      assignmentId: "a-root",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 5,
      costUsd: 1.0,
    });
    seedSession(db, {
      id: "s-child",
      assignmentId: "a-child",
      parentSessionId: "s-root",
      inputTokens: 40,
      outputTokens: 8,
      cacheReadTokens: 2,
      costUsd: 0.5,
    });

    const m = byId(listSessionCostAttribution(db));
    const root = m.get("s-root")!;
    const child = m.get("s-child")!;

    expect(child.isSubAgent).toBe(true);
    expect(child.parentSessionId).toBe("s-root");
    // The child's OWN is unchanged; the PARENT's rolledUp includes the child.
    expect(child.own).toEqual({ tokensIn: 40, tokensOut: 8, cacheRead: 2, cost: 0.5 });
    expect(root.own).toEqual({ tokensIn: 100, tokensOut: 10, cacheRead: 5, cost: 1.0 });
    expect(root.rolledUp).toEqual({ tokensIn: 140, tokensOut: 18, cacheRead: 7, cost: 1.5 });
  });

  it("rolls up across multiple levels and sibling sub-agents", () => {
    // root → mid → leaf, plus a second child directly under root.
    seedAssignment(db, "a-root", "ag", "t");
    seedAssignment(db, "a-mid", "ag", "t");
    seedAssignment(db, "a-leaf", "ag", "t");
    seedAssignment(db, "a-sib", "ag", "t");
    seedSession(db, { id: "s-root", assignmentId: "a-root", inputTokens: 1, costUsd: 0.1 });
    seedSession(db, { id: "s-mid", assignmentId: "a-mid", parentSessionId: "s-root", inputTokens: 2, costUsd: 0.2 });
    seedSession(db, { id: "s-leaf", assignmentId: "a-leaf", parentSessionId: "s-mid", inputTokens: 4, costUsd: 0.4 });
    seedSession(db, { id: "s-sib", assignmentId: "a-sib", parentSessionId: "s-root", inputTokens: 8, costUsd: 0.8 });

    const m = byId(listSessionCostAttribution(db));
    // leaf: only its own
    expect(m.get("s-leaf")!.rolledUp.tokensIn).toBe(4);
    // mid: own(2) + leaf(4)
    expect(m.get("s-mid")!.rolledUp.tokensIn).toBe(6);
    // root: own(1) + mid(2) + leaf(4) + sib(8) = 15
    expect(m.get("s-root")!.rolledUp.tokensIn).toBe(15);
    expect(m.get("s-root")!.rolledUp.cost).toBeCloseTo(1.5, 6);
  });

  it("FK guarantees every parent ref resolves in-set (a dangling parent can't be built)", () => {
    // sessions.parent_session_id REFERENCES sessions(id) — SQLite rejects both an
    // INSERT and an UPDATE that would point at a missing parent. So for this
    // full-table read every non-null parent_session_id is in-set; the source's
    // out-of-set-parent branch is defense-in-depth (mirrors the session-tree
    // assembler's contract), NOT a DB-reachable state. Assert the FK holds so the
    // rollup can rely on it.
    seedAssignment(db, "a1", "ag", "t");
    seedSession(db, { id: "s1", assignmentId: "a1", inputTokens: 7, costUsd: 0.7 });
    expect(() =>
      db.query(`UPDATE sessions SET parent_session_id = ? WHERE id = ?`).run("s-missing", "s1")
    ).toThrow(/FOREIGN KEY/);

    // The lone in-set session projects cleanly, rolledUp == own.
    const rows = listSessionCostAttribution(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rolledUp).toEqual(rows[0]!.own);
  });

  it("is cycle-safe: a self/loop parent edge never hangs the rollup", () => {
    seedAssignment(db, "a-a", "ag", "t");
    seedAssignment(db, "a-b", "ag", "t");
    // a → b and b → a (a 2-cycle). Insert with a deferred edge would violate the
    // self-ref FK on insert order, so build the loop with a raw UPDATE after insert.
    seedSession(db, { id: "s-a", assignmentId: "a-a", inputTokens: 1, costUsd: 0.1 });
    seedSession(db, { id: "s-b", assignmentId: "a-b", parentSessionId: "s-a", inputTokens: 2, costUsd: 0.2 });
    db.query(`UPDATE sessions SET parent_session_id = ? WHERE id = ?`).run("s-b", "s-a");

    // Must terminate (the visited-set + depth cap break the loop) and return both.
    const rows = listSessionCostAttribution(db);
    expect(rows).toHaveLength(2);
    const m = byId(rows);
    // Both rows exist with their own usage intact; the cycle is severed for rollup.
    expect(m.get("s-a")!.own.tokensIn).toBe(1);
    expect(m.get("s-b")!.own.tokensIn).toBe(2);
  });

  it("guard — the read model is a plain per-session projection, no interiors leak beyond its own shape", () => {
    seedAssignment(db, "a1", "ag", "t");
    seedSession(db, {
      id: "s1",
      assignmentId: "a1",
      principalId: "andreas",
      attributionTarget: "the-metafactory/cortex",
      inputTokens: 5,
      costUsd: 0.05,
    });

    const rows = listSessionCostAttribution(db);
    const allowedKeys = new Set([
      "sessionId",
      "agentId",
      "agentName",
      "forPrincipal",
      "attributionTarget",
      "substrate",
      "isSubAgent",
      "parentSessionId",
      "own",
      "rolledUp",
    ]);
    const usageKeys = new Set(["tokensIn", "tokensOut", "cacheRead", "cost"]);
    for (const r of rows) {
      expect(Object.keys(r).filter((k) => !allowedKeys.has(k))).toEqual([]);
      expect(Object.keys(r.own).filter((k) => !usageKeys.has(k))).toEqual([]);
      expect(Object.keys(r.rolledUp).filter((k) => !usageKeys.has(k))).toEqual([]);
    }
  });
});
