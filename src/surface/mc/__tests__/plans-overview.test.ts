/**
 * G-1113.D.3 — plan overview projection (api/plans.ts).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import { upsertPlan, upsertPlanPhase } from "../db/plans";
import { getPlansOverview } from "../api/plans";
import type { Plan, PlanPhase } from "../types";

const plan: Plan = {
  id: "plan-1",
  title: "Cockpit",
  kind: "design",
  sourceDocumentUrl: "https://example/doc.md",
  provider: "internal",
  externalId: null,
  umbrellaWorkItemId: null,
  status: "active",
};
const phase = (id: string, order: number, status: PlanPhase["status"]): PlanPhase => ({
  id,
  planId: "plan-1",
  title: id,
  order,
  status,
});

describe("getPlansOverview (D.3)", () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const p of paths) if (existsSync(p)) rmSync(p);
    paths.length = 0;
  });
  function freshDb() {
    const p = join(tmpdir(), `plans-ov-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("projects plan + ordered phases + status tally; currentPhaseId is the active phase", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase("p-a", 0, "done"));
    upsertPlanPhase(db, phase("p-b", 1, "active"));
    upsertPlanPhase(db, phase("p-c", 2, "not_started"));

    const [ov, ...rest] = getPlansOverview(db);
    expect(rest).toHaveLength(0);
    expect(ov?.plan.id).toBe("plan-1");
    expect(ov?.phases.map((p) => p.id)).toEqual(["p-a", "p-b", "p-c"]); // ordered
    expect(ov?.currentPhaseId).toBe("p-b"); // the active one
    expect(ov?.phaseCounts).toEqual({
      not_started: 1,
      active: 1,
      blocked: 0,
      done: 1,
      cancelled: 0,
    });
  });

  it("currentPhaseId is null when no phase is active (no guessing from order)", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phase("p-a", 0, "not_started"));
    upsertPlanPhase(db, phase("p-b", 1, "not_started"));
    const [ov] = getPlansOverview(db);
    expect(ov?.currentPhaseId).toBeNull();
    expect(ov?.phaseCounts.not_started).toBe(2);
  });

  it("handles a plan with zero phases", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    const [ov] = getPlansOverview(db);
    expect(ov?.phases).toEqual([]);
    expect(ov?.currentPhaseId).toBeNull();
    expect(ov?.phaseCounts).toEqual(emptyExpected());
  });
});

function emptyExpected() {
  return { not_started: 0, active: 0, blocked: 0, done: 0, cancelled: 0 };
}
