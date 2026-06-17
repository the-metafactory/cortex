/**
 * Consumer-side sovereignty gate tests (governance Stage 1b).
 *
 * The fail-closed invariants are the spec: an agent that cannot prove its
 * model class is compliant is denied, never waved through. The breach
 * guarded is confidential payload reaching a frontier model.
 */

import { describe, expect, it } from "bun:test";
import { evaluateSovereignty } from "../sovereignty-gate";

describe("evaluateSovereignty — the breach is guarded", () => {
  it("denies a frontier agent a local-only task", () => {
    const d = evaluateSovereignty({ model_class: "local-only", frontier_ok: false }, "frontier");
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("sovereignty violation");
  });

  it("denies an 'any' agent a local-only task (any includes frontier)", () => {
    expect(evaluateSovereignty({ model_class: "local-only" }, "any").decision).toBe("deny");
  });

  it("denies on frontier_ok:false even when model_class is 'any'", () => {
    // model_class 'any' does not itself demand local — frontier_ok:false does.
    expect(evaluateSovereignty({ model_class: "any", frontier_ok: false }, "frontier").decision).toBe("deny");
  });

  it("denies a frontier agent when frontier_ok is MISSING (fail closed, not 'frontier is fine')", () => {
    // A missing frontier_ok is treated as "not cleared for frontier".
    expect(evaluateSovereignty({ model_class: "any" }, "frontier").decision).toBe("deny");
    expect(evaluateSovereignty({ model_class: "any" }, "any").decision).toBe("deny");
    // A local-only agent is still fine — it cannot leak to a frontier model.
    expect(evaluateSovereignty({ model_class: "any" }, "local-only").decision).toBe("allow");
  });

  it("allows a local-only agent a local-only task", () => {
    expect(evaluateSovereignty({ model_class: "local-only", frontier_ok: false }, "local-only").decision).toBe("allow");
  });

  it("allows a frontier agent a frontier-ok task", () => {
    expect(evaluateSovereignty({ model_class: "any", frontier_ok: true }, "frontier").decision).toBe("allow");
  });

  it("allows a local-only agent any task (it cannot leak to frontier)", () => {
    expect(evaluateSovereignty({ model_class: "frontier", frontier_ok: true }, "local-only").decision).toBe("allow");
    expect(evaluateSovereignty({ model_class: "any" }, "local-only").decision).toBe("allow");
  });
});

describe("evaluateSovereignty — fail-closed invariants", () => {
  // cortex#1023 — DEMAND-FIRST: a missing/unknown agent class fails closed
  // ONLY when the task demands a local model. A task whose sovereignty
  // explicitly permits frontier carries nothing the class could breach.
  it("allows a class-less agent a task that explicitly permits frontier (cortex#1023)", () => {
    const d = evaluateSovereignty({ model_class: "any", frontier_ok: true }, undefined);
    expect(d.decision).toBe("allow");
    expect(d.reason).toContain("permits any model class");
  });

  it("denies a class-less agent when the task demands local (missing class)", () => {
    // frontier_ok missing → demands local → class-less fails closed.
    expect(evaluateSovereignty({ model_class: "any" }, undefined).decision).toBe("deny");
  });

  it("denies when the agent class is unknown and the task demands local", () => {
    expect(evaluateSovereignty({ model_class: "any" }, "gpu" as never).decision).toBe("deny");
  });

  it("allows an unknown-class agent a task that explicitly permits frontier (cortex#1023)", () => {
    // Same demand-first rule for unknown (not just missing) class values.
    expect(evaluateSovereignty({ model_class: "any", frontier_ok: true }, "gpu" as never).decision).toBe("allow");
  });

  it("denies when the envelope has no sovereignty block", () => {
    expect(evaluateSovereignty(null, "local-only").decision).toBe("deny");
    expect(evaluateSovereignty(undefined, "frontier").decision).toBe("deny");
  });

  it("a local-only task with no agent class denies (cannot prove compliance)", () => {
    const d = evaluateSovereignty({ model_class: "local-only" }, undefined);
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("missing or unknown");
  });

  it("a frontier_ok:false task with no agent class denies", () => {
    expect(evaluateSovereignty({ model_class: "any", frontier_ok: false }, undefined).decision).toBe("deny");
  });
});
