/**
 * B-0 (cortex#1021) — effective capability catalog derivation tests.
 *
 * Covers `deriveEffectiveCapabilityCatalog`:
 *   - explicit entries augmented with derived providers (union, stable order)
 *   - declaration-only capabilities synthesized (id + providers, empty desc)
 *   - backwards compat: a complete catalog derives byte-identically (no-op)
 *   - dedup of repeated providers; multi-agent providers ordered by declaration
 *   - inputs are never mutated
 */

import { describe, test, expect } from "bun:test";

import { deriveEffectiveCapabilityCatalog } from "../capability-catalog";
import type { Agent } from "../../types/cortex-config";
import type { Capability } from "../../types/capability";

// =============================================================================
// Fixtures
// =============================================================================

function agentFixture(
  id: string,
  capabilities: string[] = [],
): Agent {
  return {
    id,
    displayName: id,
    persona: `./personas/${id}.md`,
    trust: [],
    presence: {},
    ...(capabilities.length > 0 && {
      runtime: {
        substrate: "claude-code",
        mode: "in-process",
        capabilities,
      },
    }),
  } as Agent;
}

function cap(
  id: string,
  provided_by: string[],
  description = "explicit",
): Capability {
  return { id, description, tags: [], provided_by };
}

// =============================================================================
// Tests
// =============================================================================

describe("deriveEffectiveCapabilityCatalog", () => {
  test("empty catalog + no agent capabilities → empty result", () => {
    expect(deriveEffectiveCapabilityCatalog([], [])).toEqual([]);
    expect(deriveEffectiveCapabilityCatalog([], [agentFixture("luna")])).toEqual(
      [],
    );
  });

  test("declaration-only capability is synthesized with the declaring agent as provider", () => {
    const agents = [agentFixture("luna", ["code-review.typescript"])];
    const result = deriveEffectiveCapabilityCatalog([], agents);
    expect(result).toEqual([
      {
        id: "code-review.typescript",
        description: "",
        tags: [],
        provided_by: ["luna"],
      },
    ]);
  });

  test("explicit entry is augmented with a derived provider not already listed", () => {
    // Explicit entry lists luna; echo ALSO declares the capability → echo is
    // appended to provided_by (union, explicit first).
    const explicit = [cap("code-review.typescript", ["luna"])];
    const agents = [
      agentFixture("luna", ["code-review.typescript"]),
      agentFixture("echo", ["code-review.typescript"]),
    ];
    const result = deriveEffectiveCapabilityCatalog(explicit, agents);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("code-review.typescript");
    expect(result[0]?.provided_by).toEqual(["luna", "echo"]);
    // Description/tags from the explicit entry are preserved.
    expect(result[0]?.description).toBe("explicit");
  });

  test("backwards compat — a catalog that already lists every provider derives identically (no-op)", () => {
    const explicit = [cap("code-review.typescript", ["luna"])];
    const agents = [agentFixture("luna", ["code-review.typescript"])];
    const result = deriveEffectiveCapabilityCatalog(explicit, agents);
    // Same shape; the entry object is returned unchanged (reference-equal) when
    // the provider list didn't grow.
    expect(result).toEqual(explicit);
    expect(result[0]).toBe(explicit[0]);
  });

  test("mixed: explicit (augmented) + declaration-only (synthesized) in stable order", () => {
    const explicit = [cap("code-review.typescript", ["luna"], "review TS")];
    const agents = [
      agentFixture("luna", ["code-review.typescript", "deploy.k8s"]),
      agentFixture("echo", ["deploy.k8s"]),
    ];
    const result = deriveEffectiveCapabilityCatalog(explicit, agents);
    // Explicit entries first (in declared order), then synthesized.
    expect(result.map((c) => c.id)).toEqual([
      "code-review.typescript",
      "deploy.k8s",
    ]);
    // code-review.typescript: explicit luna, no new derived (luna already there)
    expect(result[0]?.provided_by).toEqual(["luna"]);
    expect(result[0]?.description).toBe("review TS");
    // deploy.k8s: synthesized; providers in agent-declaration order (luna, echo)
    expect(result[1]?.provided_by).toEqual(["luna", "echo"]);
    expect(result[1]?.description).toBe("");
  });

  test("duplicate declarations of the same capability by one agent dedup to a single provider entry", () => {
    const agents = [agentFixture("luna", ["x.cap", "x.cap"])];
    const result = deriveEffectiveCapabilityCatalog([], agents);
    expect(result).toHaveLength(1);
    expect(result[0]?.provided_by).toEqual(["luna"]);
  });

  test("multi-agent providers for one synthesized capability are ordered by first-seen agent", () => {
    const agents = [
      agentFixture("zeta", ["shared.cap"]),
      agentFixture("alpha", ["shared.cap"]),
    ];
    const result = deriveEffectiveCapabilityCatalog([], agents);
    expect(result[0]?.provided_by).toEqual(["zeta", "alpha"]);
  });

  test("does not mutate the inputs", () => {
    const explicit = [cap("code-review.typescript", ["luna"])];
    const explicitSnapshot = JSON.parse(JSON.stringify(explicit));
    const agents = [
      agentFixture("luna", ["code-review.typescript"]),
      agentFixture("echo", ["code-review.typescript"]),
    ];
    deriveEffectiveCapabilityCatalog(explicit, agents);
    expect(explicit).toEqual(explicitSnapshot);
    expect(explicit[0]?.provided_by).toEqual(["luna"]);
  });
});
