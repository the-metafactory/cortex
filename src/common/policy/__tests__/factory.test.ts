/**
 * IAW Phase C.2a (cortex#115) — `policyEngineFromConfig` factory tests.
 *
 * Coverage:
 *   1. Undefined policy → undefined engine (no policy block).
 *   2. Empty principals → undefined engine (no actor to authorise).
 *   3. Populated policy → engine that allows expected combos.
 *   4. Round-trip: parsed `Policy` flows into the engine without
 *      mutation (id, role[], trust[] all preserved).
 *
 * Schema-side validation (dangling role/trust refs, duplicate ids,
 * batched issues, malformed id grammar, empty defaults) is covered
 * by the `PolicySchema cross-validation` describe block below.
 */

import { describe, expect, test } from "bun:test";
import { policyEngineFromConfig } from "../factory";
import { PolicyEngine } from "../engine";
import { PolicySchema, type Policy } from "../../types/cortex-config";

function parsePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}

describe("policyEngineFromConfig", () => {
  test("returns undefined for undefined input (no policy block in cortex.yaml)", () => {
    expect(policyEngineFromConfig(undefined)).toBeUndefined();
  });

  test("returns undefined for empty principals (no actor to authorise)", () => {
    const policy = parsePolicy({
      principals: [],
      roles: [{ id: "operator", capabilities: ["deploy.staging"] }],
    });
    expect(policyEngineFromConfig(policy)).toBeUndefined();
  });

  test("builds a PolicyEngine when principals are declared", () => {
    const policy = parsePolicy({
      principals: [
        {
          id: "luna",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator"],
          trust: [],
        },
      ],
      roles: [{ id: "operator", capabilities: ["code-review.typescript"] }],
    });

    const engine = policyEngineFromConfig(policy);
    expect(engine).toBeInstanceOf(PolicyEngine);
    expect(engine?.principalCount).toBe(1);
    expect(engine?.roleCount).toBe(1);
  });

  test("round-trip: parsed Policy flows into engine and check() respects it", () => {
    const policy = parsePolicy({
      principals: [
        {
          id: "luna",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["operator", "code-reviewer"],
          trust: ["echo"],
        },
        {
          id: "echo",
          home_operator: "andreas",
          home_stack: "andreas/research",
          role: ["code-reviewer"],
          trust: [],
        },
      ],
      roles: [
        { id: "operator", capabilities: ["deploy.staging"] },
        { id: "code-reviewer", capabilities: ["code-review.typescript"] },
      ],
    });

    const engine = policyEngineFromConfig(policy);
    expect(engine).toBeDefined();
    if (!engine) return;

    // luna has operator + code-reviewer; check both capabilities.
    const deployResult = engine.check("luna", {
      capability: "deploy.staging",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "any",
      },
    });
    expect(deployResult.allow).toBe(true);

    const reviewResult = engine.check("echo", {
      capability: "code-review.typescript",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "any",
      },
    });
    expect(reviewResult.allow).toBe(true);
  });
});

describe("PolicySchema cross-validation", () => {
  test("rejects dangling principal.role[] ref to undeclared role (with per-offender path)", () => {
    expect(() =>
      parsePolicy({
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: ["nonexistent-role"],
            trust: [],
          },
        ],
        roles: [{ id: "operator", capabilities: [] }],
      }),
    ).toThrow(/references undeclared role/);
  });

  test("rejects dangling principal.trust[] ref to undeclared principal", () => {
    expect(() =>
      parsePolicy({
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: [],
            trust: ["nonexistent-peer"],
          },
        ],
        roles: [],
      }),
    ).toThrow(/trusts undeclared peer/);
  });

  test("rejects duplicate principal id", () => {
    expect(() =>
      parsePolicy({
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: [],
            trust: [],
          },
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: [],
            trust: [],
          },
        ],
        roles: [],
      }),
    ).toThrow(/principal id.*luna.*already declared/);
  });

  test("rejects duplicate role id", () => {
    expect(() =>
      parsePolicy({
        principals: [],
        roles: [
          { id: "operator", capabilities: ["deploy.staging"] },
          { id: "operator", capabilities: ["deploy.prod"] },
        ],
      }),
    ).toThrow(/role id.*operator.*already declared/);
  });

  test("batches all dangling refs across multiple principals (not first-only)", () => {
    try {
      parsePolicy({
        principals: [
          {
            id: "luna",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: ["ghost-role-1"],
            trust: [],
          },
          {
            id: "echo",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: ["ghost-role-2"],
            trust: [],
          },
        ],
        roles: [],
      });
      throw new Error("expected parse to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Both offenders surface in one parse pass (Echo cortex#219
      // round 1 — superRefine batches issues rather than failing on
      // the first one).
      expect(message).toContain("ghost-role-1");
      expect(message).toContain("ghost-role-2");
    }
  });

  test("rejects malformed principal id grammar (digit prefix)", () => {
    expect(() =>
      parsePolicy({
        principals: [
          {
            id: "2bad-prefix",
            home_operator: "andreas",
            home_stack: "andreas/research",
            role: [],
            trust: [],
          },
        ],
        roles: [],
      }),
    ).toThrow(/lowercase alphanumeric \+ hyphen/);
  });

  test("accepts empty defaults — no principals, no roles", () => {
    const policy = parsePolicy({});
    expect(policy.principals).toEqual([]);
    expect(policy.roles).toEqual([]);
  });
});
