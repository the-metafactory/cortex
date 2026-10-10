/**
 * cortex#2195 — the model-placement execute gate (RFC-0005 §2.5 consumer half).
 * Unit coverage for the pure decision logic: config-declared harness→placement
 * resolution (fail-closed on unknown) + the frontier/local refusal rule read via
 * the myelin `parseSovereignty` reader.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateModelPlacement,
  resolvePlacementClass,
  type ModelPlacementConfig,
  type PlacementSovereignty,
} from "../model-placement-gate";

/** A sovereignty block that DEMANDS local execution (frontier_ok false). */
const LOCAL_ONLY: PlacementSovereignty = {
  classification: "confidential",
  data_residency: "NZ",
  max_hop: 0,
  frontier_ok: false,
  model_class: "local-only",
};

/** A sovereignty block that CLEARS frontier (frontier_ok + not local-only). */
const FRONTIER_OK: PlacementSovereignty = {
  classification: "public",
  data_residency: "NZ",
  max_hop: 3,
  frontier_ok: true,
  model_class: "any",
};

const env = (sovereignty: PlacementSovereignty) => ({ sovereignty });

describe("resolvePlacementClass — config-declared, fail-closed on unknown", () => {
  const config: ModelPlacementConfig = {
    harnesses: { "claude-code": "frontier", "local-llm": "local" },
  };

  test("a mapped harness resolves to its declared class", () => {
    expect(resolvePlacementClass("claude-code", config)).toBe("frontier");
    expect(resolvePlacementClass("local-llm", config)).toBe("local");
  });

  test("an UNKNOWN harness fails closed to frontier (the unsafe direction)", () => {
    // No hardcoded model list — an unmapped id must not silently be treated as
    // local; the default fail-closed is `frontier` so a local-only envelope
    // never runs on an unclassified harness.
    expect(resolvePlacementClass("mystery-harness", config)).toBe("frontier");
  });

  test("an explicit config default overrides the built-in fail-closed", () => {
    const withLocalDefault: ModelPlacementConfig = { harnesses: {}, default: "local" };
    expect(resolvePlacementClass("anything", withLocalDefault)).toBe("local");
  });
});

describe("evaluateModelPlacement — RFC-0005 §2.5 enforcement", () => {
  const config: ModelPlacementConfig = {
    harnesses: { "claude-code": "frontier", "local-llm": "local" },
  };

  test("frontier harness + local-only envelope → REFUSED", () => {
    const d = evaluateModelPlacement(env(LOCAL_ONLY), "claude-code", config);
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.placement).toBe("frontier");
      expect(d.detail).toContain("claude-code");
    }
  });

  test("frontier harness + frontier-cleared envelope → allowed", () => {
    const d = evaluateModelPlacement(env(FRONTIER_OK), "claude-code", config);
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.placement).toBe("frontier");
  });

  test("local harness runs ANY envelope (cannot leak to frontier) → allowed", () => {
    expect(evaluateModelPlacement(env(LOCAL_ONLY), "local-llm", config).allow).toBe(true);
    expect(evaluateModelPlacement(env(FRONTIER_OK), "local-llm", config).allow).toBe(true);
  });

  test("UNKNOWN harness + local-only envelope → REFUSED (fail-closed)", () => {
    // The acceptance scenario: only an unclassified/frontier harness is
    // available for a local-only-demanding envelope → refuse.
    const d = evaluateModelPlacement(env(LOCAL_ONLY), "unmapped", config);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.placement).toBe("frontier");
  });

  test("frontier harness + missing frontier_ok is treated as not-cleared → REFUSED", () => {
    // parseSovereignty: canReachFrontier = frontier_ok && model_class !== local-only.
    // A falsy/absent frontier_ok fails closed.
    const noClearance = { ...FRONTIER_OK, frontier_ok: false } as PlacementSovereignty;
    expect(evaluateModelPlacement(env(noClearance), "claude-code", config).allow).toBe(false);
  });

  test("frontier harness + model_class local-only (even with frontier_ok true) → REFUSED", () => {
    const localClass = { ...FRONTIER_OK, model_class: "local-only" } as PlacementSovereignty;
    expect(evaluateModelPlacement(env(localClass), "claude-code", config).allow).toBe(false);
  });
});
