/**
 * G-1113.D.1 — Plan + PlanPhase storage round-trip.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { rmSync, existsSync } from "fs";
import { initDatabase } from "../db/init";
import {
  upsertPlan,
  getPlan,
  listPlans,
  upsertPlanPhase,
  getPlanPhase,
  listPhasesForPlan,
} from "../db/plans";
import type { Plan, PlanPhase } from "../types";

const plan: Plan = {
  id: "plan-1",
  title: "Mission Control Cockpit",
  kind: "design",
  sourceDocumentUrl: "https://github.com/the-metafactory/cortex/blob/main/docs/plan-mission-control-cockpit.md",
  provider: "github",
  externalId: "the-metafactory/cortex#354",
  umbrellaWorkItemId: null,
  status: "active",
};
const phaseA: PlanPhase = { id: "phase-a", planId: "plan-1", title: "Grounding", order: 0, status: "done" };
const phaseB: PlanPhase = { id: "phase-b", planId: "plan-1", title: "Provider-Neutral Source Refs", order: 1, status: "active" };

describe("plans storage (D.1)", () => {
  const paths: string[] = [];
  afterEach(() => { for (const p of paths) if (existsSync(p)) rmSync(p); paths.length = 0; });
  function freshDb() {
    const p = join(tmpdir(), `plans-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    paths.push(p);
    return initDatabase(p);
  }

  it("round-trips a plan (upsert → get → list) + idempotent status update", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    expect(getPlan(db, "plan-1")).toEqual(plan);
    expect(listPlans(db)).toEqual([plan]);
    upsertPlan(db, { ...plan, status: "done" });
    expect(getPlan(db, "plan-1")).toEqual({ ...plan, status: "done" });
    expect(listPlans(db)).toHaveLength(1);
  });

  it("round-trips phases, ordered by phase_order", () => {
    const db = freshDb();
    upsertPlan(db, plan);
    upsertPlanPhase(db, phaseB);
    upsertPlanPhase(db, phaseA);
    expect(getPlanPhase(db, "phase-a")).toEqual(phaseA);
    // listed by order (A before B despite insert order)
    expect(listPhasesForPlan(db, "plan-1")).toEqual([phaseA, phaseB]);
  });

  it("CHECK rejects out-of-vocabulary kind / status", () => {
    const db = freshDb();
    expect(() => upsertPlan(db, { ...plan, kind: "bogus" as Plan["kind"] })).toThrow();
    expect(() => upsertPlan(db, { ...plan, status: "bogus" as Plan["status"] })).toThrow();
    upsertPlan(db, plan);
    expect(() => upsertPlanPhase(db, { ...phaseA, status: "bogus" as PlanPhase["status"] })).toThrow();
  });

  it("phase FK enforced (ghost plan_id throws); unknown ids → null", () => {
    const db = freshDb();
    expect(() => upsertPlanPhase(db, { ...phaseA, planId: "ghost" })).toThrow();
    expect(getPlan(db, "nope")).toBeNull();
    expect(getPlanPhase(db, "nope")).toBeNull();
  });
});
