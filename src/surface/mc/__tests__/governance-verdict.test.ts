/**
 * G-1115 — governance verdict projection + API tests (governance Stage 5).
 *
 * Verifies:
 *   1. Projection: all four layer envelopes land as rows with layer-correct
 *      decision extraction; principal/stack parsed from the subject.
 *   2. Idempotency: a redelivered envelope (same id) is not double-inserted.
 *   3. Fail-closed filters: non-governance types, malformed payloads, and
 *      missing envelope ids project nothing — and never throw.
 *   4. Renderer seam: the governance subjects are in the adapter grammar and
 *      match real derived subjects via the surface-router's matcher; render()
 *      routes a governance envelope; garbage never throws.
 *   5. API: empty DB → honest zeros + alarm none; seeded denials drive the
 *      deterministic alarm tiers; window + cap respected.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import {
  projectGovernanceVerdict,
  type ProjectableGovernanceEnvelope,
} from "../projection/governance-verdict";
import {
  createDispatchProjectionRenderer,
  DISPATCH_PROJECTION_SUBJECTS,
} from "../projection/dispatch-lifecycle-renderer";
import { subjectMatches } from "../../../bus/surface-router";
import { alarmFor, getGovernance } from "../api/governance";
import { insertGovernanceVerdict, listRecentVerdicts } from "../db/governance";
import type { Envelope } from "../../../bus/myelin/envelope-validator";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

const SUBJECT = "local.switch-soc.default.governance.verdict.l0";

function envelope(
  type: string,
  payload: Record<string, unknown>,
  id = crypto.randomUUID(),
): ProjectableGovernanceEnvelope {
  return { id, type, source: "switch-soc.default.pulse", payload };
}

function rowCount(db: Database): number {
  return (db.query(`SELECT COUNT(*) AS n FROM governance_verdicts`).get() as { n: number }).n;
}

describe("projectGovernanceVerdict", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("projects all four layers with layer-correct decision extraction", () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["governance.verdict.l0", { name: "containment", tool: "containment", decision: "ask", reason: "judgment call" }, "ask"],
      ["governance.verdict.tribunal", { name: "containment-panel", verdict: "defer", reason: "below confidence bar" }, "defer"],
      ["governance.verdict.gate", { name: "analyst", verdict: "pass", notes: "analyst approves" }, "pass"],
      ["governance.verdict.resolved", { name: "containment", outcome: "allow", resolved_by: "gate" }, "allow"],
    ];
    for (const [type, payload, expected] of cases) {
      const res = projectGovernanceVerdict(db, envelope(type, payload), SUBJECT);
      expect(res?.decision).toBe(expected);
      expect(res?.rowId).not.toBeNull();
    }
    expect(rowCount(db)).toBe(4);

    const rows = listRecentVerdicts(db, 30, 100);
    expect(rows).toHaveLength(4);
    // Subject identity parsed (stack-ful local grammar).
    expect(rows[0]?.principal).toBe("switch-soc");
    expect(rows[0]?.stack).toBe("default");
    // The gate's analyst notes land as the reason.
    const gate = rows.find((r) => r.layer === "gate");
    expect(gate?.reason).toBe("analyst approves");
    const resolved = rows.find((r) => r.layer === "resolved");
    expect(resolved?.resolvedBy).toBe("gate");
  });

  it("is idempotent on envelope id — redelivery does not double-insert", () => {
    const env = envelope("governance.verdict.l0", { name: "x", decision: "deny", reason: "no" });
    const first = projectGovernanceVerdict(db, env, SUBJECT);
    const second = projectGovernanceVerdict(db, env, SUBJECT);
    expect(first?.rowId).not.toBeNull();
    expect(second?.rowId).toBeNull(); // recognized redelivery
    expect(rowCount(db)).toBe(1);
  });

  it("returns null for non-governance types, unknown layers, malformed payloads, missing ids", () => {
    expect(projectGovernanceVerdict(db, envelope("dispatch.task.started", { x: 1 }))).toBeNull();
    expect(projectGovernanceVerdict(db, envelope("governance.verdict.bogus", { decision: "allow" }))).toBeNull();
    // l0 without a decision field — malformed, dropped.
    expect(projectGovernanceVerdict(db, envelope("governance.verdict.l0", { name: "x" }))).toBeNull();
    // No envelope id — no idempotency key, refuse to project.
    expect(
      projectGovernanceVerdict(db, { type: "governance.verdict.l0", payload: { decision: "allow" } }),
    ).toBeNull();
    expect(rowCount(db)).toBe(0);
  });

  it("parses stack-less local subjects too", () => {
    const res = projectGovernanceVerdict(
      db,
      envelope("governance.verdict.l0", { name: "x", decision: "allow" }),
      "local.jc.governance.verdict.l0",
    );
    expect(res).not.toBeNull();
    const [row] = listRecentVerdicts(db, 30, 1);
    expect(row?.principal).toBe("jc");
    expect(row?.stack).toBeNull();
  });
});

describe("renderer seam (G-1115)", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("the adapter grammar matches real derived governance subjects", () => {
    const derived = [
      "local.switch-soc.default.governance.verdict.l0",
      "local.jc.governance.verdict.resolved",
      "federated.andreas.default.governance.verdict.tribunal",
    ];
    for (const subject of derived) {
      const matched = DISPATCH_PROJECTION_SUBJECTS.some((p) => subjectMatches(p, subject));
      expect(matched).toBe(true);
    }
  });

  it("render() routes a governance envelope into a row and never throws on garbage", async () => {
    const adapter = createDispatchProjectionRenderer(db);
    const env = {
      id: crypto.randomUUID(),
      source: "switch-soc.default.pulse",
      type: "governance.verdict.resolved",
      timestamp: new Date().toISOString(),
      sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "any" },
      payload: { name: "containment", outcome: "deny", resolved_by: "tribunal", reason: "majority deny" },
    } as unknown as Envelope;
    await adapter.render(env, undefined, SUBJECT.replace(".l0", ".resolved"));
    expect(rowCount(db)).toBe(1);

    // Garbage payload through the same seam — swallowed, not thrown.
    const garbage = { ...env, id: crypto.randomUUID(), payload: "not-an-object" } as unknown as Envelope;
    await adapter.render(garbage, undefined, SUBJECT);
    expect(rowCount(db)).toBe(1);
  });
});

describe("GET /api/governance", () => {
  let db: Database;
  beforeEach(() => {
    db = setupDb();
  });
  afterEach(() => {
    db.close();
  });

  it("empty DB → zero summary, alarm none, note names the window", () => {
    const res = getGovernance(db);
    expect(res.verdicts).toHaveLength(0);
    expect(res.summary.total).toBe(0);
    expect(res.alarm.tier).toBe("none");
    expect(res.alarm.note).toMatch(/not absence of risk/);
  });

  it("alarm tiers are deterministic on 24h denials", () => {
    expect(alarmFor(0).tier).toBe("none");
    expect(alarmFor(1).tier).toBe("elevated");
    expect(alarmFor(4).tier).toBe("elevated");
    expect(alarmFor(5).tier).toBe("high");
    expect(alarmFor(12).tier).toBe("high");
  });

  it("counts outcomes from resolved rows and recent denials across layers", () => {
    const seed = (layer: "l0" | "tribunal" | "gate" | "resolved", decision: string) =>
      insertGovernanceVerdict(db, {
        envelopeId: crypto.randomUUID(),
        layer,
        decision,
        name: "containment",
        payload: {},
      });
    seed("resolved", "allow");
    seed("resolved", "deny");
    seed("resolved", "deny");
    seed("resolved", "defer");
    seed("l0", "deny");
    seed("gate", "fail");
    seed("tribunal", "allow");

    const res = getGovernance(db);
    expect(res.summary.total).toBe(7);
    expect(res.summary.allows).toBe(1);
    expect(res.summary.denials).toBe(2);
    expect(res.summary.defers).toBe(1);
    expect(res.summary.byLayer.resolved).toBe(4);
    // denials24h: resolved deny ×2 + l0 deny + gate fail = 4 → elevated.
    expect(res.summary.denials24h).toBe(4);
    expect(res.alarm.tier).toBe("elevated");
  });
});
