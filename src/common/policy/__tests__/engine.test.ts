/**
 * IAW Phase C.1 (cortex#115) — PolicyEngine tests.
 *
 * Coverage axes:
 *   1. Happy path — principal with a role granting the requested
 *      capability → allow + full effective capability set.
 *   2. Unknown principal → `unknown_principal` reason.
 *   3. Capability not in role grant → `insufficient_role`.
 *   4. Multi-role union — principal with two roles → effective
 *      capabilities = union; intent against either role's
 *      capability succeeds.
 *   5. Empty role list → every capability check fails with
 *      `insufficient_role` (no capability is reachable).
 *   6. Unknown role id silently skipped — principal with one valid
 *      + one unknown role gets only the valid role's grants
 *      (config-validation lives upstream at parse time per the
 *      engine JSDoc).
 *   7. Sovereignty field is a no-op at C.1 (smoke test that an
 *      otherwise-allowed intent isn't rejected on sovereignty
 *      grounds — the discriminator variant exists for forward
 *      compat but the engine doesn't fire it).
 *   8. `principalCount` + `roleCount` smoke — boot-log accessors.
 */

import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "../engine";
import type {
  Intent,
  Principal,
  RoleDefinition,
} from "../types";

// =============================================================================
// Fixtures
// =============================================================================

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    id: "luna",
    home_operator: "andreas",
    home_stack: "andreas/research",
    role: ["operator"],
    trust: [],
    ...overrides,
  };
}

function role(id: string, capabilities: string[]): RoleDefinition {
  return { id, capabilities };
}

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    capability: "code-review.typescript",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "any",
    },
    ...overrides,
  };
}

// =============================================================================
// Cases
// =============================================================================

describe("PolicyEngine — happy path", () => {
  test("principal with a role granting the requested capability → allow", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["code-review.typescript", "deploy.staging"])],
    });

    const result = engine.check("luna", intent());

    expect(result.allow).toBe(true);
    if (result.allow) {
      // Effective set is the role's full capability list, not just
      // the requested capability — downstream callers filter on it.
      expect(new Set(result.capabilities)).toEqual(
        new Set(["code-review.typescript", "deploy.staging"]),
      );
    }
  });
});

describe("PolicyEngine — rejection paths", () => {
  test("unknown principal → unknown_principal reason", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna" })],
      roles: [role("operator", ["code-review.typescript"])],
    });

    const result = engine.check("nobody", intent());

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "unknown_principal",
        principal_id: "nobody",
      });
    }
  });

  test("capability not in role grant → insufficient_role", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["deploy.staging"])],
    });

    const result = engine.check(
      "luna",
      intent({ capability: "code-review.typescript" }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "insufficient_role",
        missing_capability: "code-review.typescript",
        principal_id: "luna",
      });
    }
  });

  test("empty role list → insufficient_role on any capability", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: [] })],
      roles: [role("operator", ["code-review.typescript"])],
    });

    const result = engine.check("luna", intent());

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason.kind).toBe("insufficient_role");
    }
  });
});

describe("PolicyEngine — role union semantics", () => {
  test("multi-role principal: effective capabilities = union; intent against either role succeeds", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({ id: "luna", role: ["operator", "code-reviewer"] }),
      ],
      roles: [
        role("operator", ["deploy.staging"]),
        role("code-reviewer", ["code-review.typescript", "code-review.rust"]),
      ],
    });

    // Either capability resolves.
    const deployResult = engine.check(
      "luna",
      intent({ capability: "deploy.staging" }),
    );
    const reviewResult = engine.check(
      "luna",
      intent({ capability: "code-review.typescript" }),
    );

    expect(deployResult.allow).toBe(true);
    expect(reviewResult.allow).toBe(true);
    if (deployResult.allow) {
      expect(new Set(deployResult.capabilities)).toEqual(
        new Set([
          "deploy.staging",
          "code-review.typescript",
          "code-review.rust",
        ]),
      );
    }
  });

  test("unknown role id silently skipped — only valid roles' grants count", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({ id: "luna", role: ["operator", "ghost-role"] }),
      ],
      // Note: `ghost-role` deliberately NOT in roles list.
      roles: [role("operator", ["deploy.staging"])],
    });

    const result = engine.check(
      "luna",
      intent({ capability: "deploy.staging" }),
    );

    expect(result.allow).toBe(true);
    if (result.allow) {
      // ghost-role's capabilities are not in the effective set.
      expect(new Set(result.capabilities)).toEqual(
        new Set(["deploy.staging"]),
      );
    }
  });
});

describe("PolicyEngine — sovereignty (C.1 smoke)", () => {
  test("sovereignty field is part of input shape but doesn't reject at C.1", () => {
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["code-review.typescript"])],
    });

    // Federated classification — strongest sovereignty signal cortex
    // emits today. C.1 doesn't reject on this; Phase D will.
    const result = engine.check(
      "luna",
      intent({
        sovereignty: {
          classification: "federated",
          data_residency: "US",
          max_hop: 4,
          frontier_ok: true,
          model_class: "frontier",
        },
      }),
    );

    expect(result.allow).toBe(true);
  });
});

describe("PolicyEngine — boot accessors", () => {
  test("principalCount + roleCount reflect constructor opts", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({ id: "luna" }),
        principal({ id: "echo" }),
        principal({ id: "holly" }),
      ],
      roles: [
        role("operator", []),
        role("code-reviewer", []),
      ],
    });

    expect(engine.principalCount).toBe(3);
    expect(engine.roleCount).toBe(2);
  });
});

// =============================================================================
// IAW Phase D.3 (cortex#116) — per-network policy slicing
// =============================================================================

describe("PolicyEngine — federation slicing (D.3)", () => {
  test("local dispatch (no source_network) → C.3 behaviour unchanged: federation branch inert", () => {
    // Engine has a federated config, but the intent doesn't reference
    // a source_network — the federation branch must not fire. This is
    // the backward-compatibility check: pre-D.3 callers (everyone
    // dispatching locally) see no behaviour change.
    const engine = new PolicyEngine({
      principals: [principal({ id: "luna", role: ["operator"] })],
      roles: [role("operator", ["code-review.typescript"])],
      federated: {
        networks: [
          { id: "research-collab", peers: [{ stack_id: "andreas/research" }] },
        ],
      },
    });

    const result = engine.check("luna", intent());
    expect(result.allow).toBe(true);
  });

  test("federated dispatch + principal in peer roster → allow (capability check still applies)", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({
          id: "luna",
          home_stack: "andreas/research",
          role: ["operator"],
        }),
      ],
      roles: [role("operator", ["code-review.typescript"])],
      federated: {
        networks: [
          {
            id: "research-collab",
            peers: [{ stack_id: "andreas/research" }],
          },
        ],
      },
    });

    const result = engine.check(
      "luna",
      intent({ source_network: "research-collab" }),
    );
    expect(result.allow).toBe(true);
    if (result.allow) {
      expect(new Set(result.capabilities)).toEqual(
        new Set(["code-review.typescript"]),
      );
    }
  });

  test("federated dispatch + unknown network id → unknown_network deny", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({
          id: "luna",
          home_stack: "andreas/research",
          role: ["operator"],
        }),
      ],
      roles: [role("operator", ["code-review.typescript"])],
      federated: {
        networks: [
          {
            id: "research-collab",
            peers: [{ stack_id: "andreas/research" }],
          },
        ],
      },
    });

    const result = engine.check(
      "luna",
      intent({ source_network: "phantom-network" }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "unknown_network",
        source_network: "phantom-network",
        principal_id: "luna",
      });
    }
  });

  test("federated dispatch + principal's home_stack not in peer roster → stack_not_in_network deny", () => {
    const engine = new PolicyEngine({
      principals: [
        // luna's home_stack is `andreas/research`...
        principal({
          id: "luna",
          home_stack: "andreas/research",
          role: ["operator"],
        }),
      ],
      roles: [role("operator", ["code-review.typescript"])],
      federated: {
        networks: [
          {
            id: "partner-only",
            // ...but `partner-only` lists only `jcfischer/sage-host`.
            peers: [{ stack_id: "jcfischer/sage-host" }],
          },
        ],
      },
    });

    const result = engine.check(
      "luna",
      intent({ source_network: "partner-only" }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "stack_not_in_network",
        principal_id: "luna",
        source_network: "partner-only",
        home_stack: "andreas/research",
      });
    }
  });

  test("federation deny fires AFTER capability check — insufficient_role wins on a federated dispatch with capability miss", () => {
    // Closest-miss principle: a principal who lacks the capability
    // AND is not in the network's peer roster should see
    // `insufficient_role` (the local issue) rather than
    // `stack_not_in_network` (the federation issue). Operators
    // triaging deny logs see the nearest failure first.
    const engine = new PolicyEngine({
      principals: [
        principal({
          id: "luna",
          home_stack: "andreas/research",
          role: ["operator"],
        }),
      ],
      // operator role has NO capabilities — capability check misses.
      roles: [role("operator", [])],
      federated: {
        networks: [
          { id: "partner-only", peers: [{ stack_id: "jcfischer/sage-host" }] },
        ],
      },
    });

    const result = engine.check(
      "luna",
      intent({
        capability: "code-review.typescript",
        source_network: "partner-only",
      }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      // Capability check (C.3) fires before the federation branch (D.3).
      expect(result.reason.kind).toBe("insufficient_role");
    }
  });

  test("federated dispatch + engine has no federated config → unknown_network (federated config absent === network undeclared)", () => {
    // Without a federated config, every federated dispatch denies
    // with `unknown_network`. This matches the policy intent: if the
    // operator hasn't declared any networks, no inbound federated
    // traffic should be authorised regardless of the principal.
    const engine = new PolicyEngine({
      principals: [
        principal({
          id: "luna",
          home_stack: "andreas/research",
          role: ["operator"],
        }),
      ],
      roles: [role("operator", ["code-review.typescript"])],
      // No `federated` field — engine has no networks.
    });

    const result = engine.check(
      "luna",
      intent({ source_network: "research-collab" }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "unknown_network",
        source_network: "research-collab",
        principal_id: "luna",
      });
    }
  });

  test("unknown_principal still fires before the federation branch on a federated dispatch", () => {
    // Sanity: an envelope arriving on a federated subject whose
    // signed_by[0].principal isn't a declared local principal denies
    // at the very first gate — the federation branch never runs.
    const engine = new PolicyEngine({
      principals: [],
      roles: [],
      federated: {
        networks: [
          { id: "research-collab", peers: [{ stack_id: "andreas/research" }] },
        ],
      },
    });

    const result = engine.check(
      "ghost",
      intent({ source_network: "research-collab" }),
    );

    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.reason).toEqual({
        kind: "unknown_principal",
        principal_id: "ghost",
      });
    }
  });

  test("multiple peers in a network — match against any peer stack_id allows", () => {
    const engine = new PolicyEngine({
      principals: [
        principal({
          id: "luna",
          home_stack: "andreas/research",
          role: ["operator"],
        }),
      ],
      roles: [role("operator", ["code-review.typescript"])],
      federated: {
        networks: [
          {
            id: "research-collab",
            peers: [
              { stack_id: "jcfischer/sage-host" },
              { stack_id: "andreas/research" },
              { stack_id: "ben/atlas" },
            ],
          },
        ],
      },
    });

    const result = engine.check(
      "luna",
      intent({ source_network: "research-collab" }),
    );

    expect(result.allow).toBe(true);
  });
});
