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

  test("D.3 — parsed federated block round-trips into engine; federated check() honours peer roster", () => {
    const pubkey = "U" + "D".repeat(55);
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
      federated: {
        networks: [
          {
            id: "research-collab",
            leaf_node: "leaf",
            peers: [
              {
                operator_id: "andreas",
                stack_id: "andreas/research",
                operator_pubkey: pubkey,
              },
            ],
            accept_subjects: ["federated.research-collab.>"],
            deny_subjects: [],
            announce_capabilities: [],
            max_hop: 0,
          },
        ],
      },
    });
    const engine = policyEngineFromConfig(policy);
    expect(engine).toBeDefined();
    if (!engine) return;

    // Federated dispatch — principal's home_stack is in the network's
    // peer roster; allow.
    const allowResult = engine.check("luna", {
      capability: "code-review.typescript",
      sovereignty: {
        classification: "federated",
        data_residency: "NZ",
        max_hop: 1,
        frontier_ok: false,
        model_class: "any",
      },
      source_network: "research-collab",
    });
    expect(allowResult.allow).toBe(true);

    // Federated dispatch — unknown network id; deny.
    const unknownNetworkResult = engine.check("luna", {
      capability: "code-review.typescript",
      sovereignty: {
        classification: "federated",
        data_residency: "NZ",
        max_hop: 1,
        frontier_ok: false,
        model_class: "any",
      },
      source_network: "phantom",
    });
    expect(unknownNetworkResult.allow).toBe(false);
    if (!unknownNetworkResult.allow) {
      expect(unknownNetworkResult.reason.kind).toBe("unknown_network");
    }
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

// ---------------------------------------------------------------------------
// IAW Phase D.1 (cortex#116) — federated network schema
// ---------------------------------------------------------------------------

const PEER_PUBKEY_A = "U" + "A".repeat(55);
const PEER_PUBKEY_B = "U" + "B".repeat(55);
const PEER_PUBKEY_C = "U" + "C".repeat(55);

describe("PolicyFederatedSchema", () => {
  test("accepts a fully-populated federated network", () => {
    const policy = PolicySchema.parse({
      federated: {
        networks: [
          {
            id: "research-collab",
            leaf_node: "nats-leaf-research",
            peers: [
              {
                operator_id: "jcfischer",
                stack_id: "jcfischer/sage-host",
                operator_pubkey: PEER_PUBKEY_A,
              },
            ],
            accept_subjects: ["federated.research-collab.tasks.code-review.*"],
            deny_subjects: ["federated.research-collab.tasks.*.private.*"],
            announce_capabilities: ["code-review.typescript", "security-scan.web"],
            max_hop: 1,
          },
        ],
      },
    });
    expect(policy.federated?.networks).toHaveLength(1);
    expect(policy.federated?.networks[0]?.peers).toHaveLength(1);
  });

  test("federated block is optional — absence parses cleanly", () => {
    const policy = PolicySchema.parse({});
    expect(policy.federated).toBeUndefined();
  });

  test("networks[] defaults to empty when block present", () => {
    const policy = PolicySchema.parse({ federated: {} });
    expect(policy.federated?.networks).toEqual([]);
  });

  test("max_hop must be a non-negative integer", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf", peers: [],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: -1,
          }],
        },
      }),
    ).toThrow();
  });

  test("rejects malformed network id grammar (digit prefix)", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "1bad", leaf_node: "leaf", peers: [],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/network id must be lowercase alphanumeric/);
  });

  test("rejects malformed accept_subjects[] entry (uppercase segment)", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf", peers: [],
            accept_subjects: ["federated.BAD-UPPERCASE.tasks.>"],
            deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/accept_subjects/);
  });

  test("rejects malformed announce_capabilities[] (single segment)", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf", peers: [],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: ["bare-capability-no-dot"],
            max_hop: 0,
          }],
        },
      }),
    ).toThrow(/<domain>\.<entity>/);
  });

  test("rejects peer.operator_pubkey that isn't a U-prefixed NKey", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf",
            peers: [{
              operator_id: "alpha", stack_id: "alpha/main",
              operator_pubkey: "not-an-nkey",
            }],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/operator_pubkey must be a base32 NKey/);
  });
});

describe("PolicyFederatedSchema cross-validation", () => {
  test("rejects duplicate network id", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [
            { id: "n", leaf_node: "leaf", peers: [], accept_subjects: [], deny_subjects: [], announce_capabilities: [], max_hop: 0 },
            { id: "n", leaf_node: "leaf", peers: [], accept_subjects: [], deny_subjects: [], announce_capabilities: [], max_hop: 0 },
          ],
        },
      }),
    ).toThrow(/network id.*n.*already declared/);
  });

  test("rejects peer.stack_id whose prefix doesn't match peer.operator_id", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf",
            peers: [{
              operator_id: "jcfischer",
              // Drifted prefix — would let an operator forge attribution.
              stack_id: "evil-actor/sage-host",
              operator_pubkey: PEER_PUBKEY_A,
            }],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/must start with peer\.operator_id/);
  });

  test("rejects duplicate peer.stack_id within a network", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf",
            peers: [
              { operator_id: "alpha", stack_id: "alpha/main", operator_pubkey: PEER_PUBKEY_A },
              { operator_id: "alpha", stack_id: "alpha/main", operator_pubkey: PEER_PUBKEY_B },
            ],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/peer\.stack_id.*already declared/);
  });

  test("rejects duplicate peer.operator_pubkey within a network (paste error)", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "n", leaf_node: "leaf",
            peers: [
              { operator_id: "alpha", stack_id: "alpha/main", operator_pubkey: PEER_PUBKEY_A },
              { operator_id: "beta", stack_id: "beta/main", operator_pubkey: PEER_PUBKEY_A },
            ],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/operator_pubkey already declared.*pubkey collision/);
  });

  test("same operator_pubkey is allowed across DIFFERENT networks (cross-network dedup not enforced)", () => {
    // Per-network uniqueness only — a single operator's stack may
    // legitimately participate in multiple networks with the same
    // pubkey. The schema doesn't reject this.
    const policy = PolicySchema.parse({
      federated: {
        networks: [
          {
            id: "net-a", leaf_node: "leaf",
            peers: [{ operator_id: "alpha", stack_id: "alpha/main", operator_pubkey: PEER_PUBKEY_A }],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          },
          {
            id: "net-b", leaf_node: "leaf",
            peers: [{ operator_id: "alpha", stack_id: "alpha/main", operator_pubkey: PEER_PUBKEY_A }],
            accept_subjects: [], deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          },
        ],
      },
    });
    expect(policy.federated?.networks).toHaveLength(2);
  });

  test("batches multiple federation issues across networks", () => {
    try {
      PolicySchema.parse({
        federated: {
          networks: [
            { id: "dup", leaf_node: "leaf", peers: [], accept_subjects: [], deny_subjects: [], announce_capabilities: [], max_hop: 0 },
            { id: "dup", leaf_node: "leaf", peers: [], accept_subjects: [], deny_subjects: [], announce_capabilities: [], max_hop: 0 },
            {
              id: "other", leaf_node: "leaf",
              peers: [
                { operator_id: "alpha", stack_id: "wrong-prefix/main", operator_pubkey: PEER_PUBKEY_A },
              ],
              accept_subjects: [], deny_subjects: [],
              announce_capabilities: [], max_hop: 0,
            },
          ],
        },
      });
      throw new Error("expected parse to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("dup");
      expect(message).toContain("must start with peer.operator_id");
    }
  });

  test("rejects accept_subjects[] entry not prefixed with federated.{network.id}. (Echo cortex#223 round 1)", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "research-collab", leaf_node: "leaf", peers: [],
            // Out-of-scope subject — surface-router would have to
            // defend at runtime. Schema rejects.
            accept_subjects: ["internal.private.>"],
            deny_subjects: [],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/must begin with.*federated.*research-collab/);
  });

  test("rejects deny_subjects[] entry not prefixed with federated.{network.id}. (Echo cortex#223 round 1)", () => {
    expect(() =>
      PolicySchema.parse({
        federated: {
          networks: [{
            id: "research-collab", leaf_node: "leaf", peers: [],
            accept_subjects: ["federated.research-collab.>"],
            deny_subjects: ["local.metafactory.>"],
            announce_capabilities: [], max_hop: 0,
          }],
        },
      }),
    ).toThrow(/must begin with.*federated.*research-collab/);
  });

  test("accepts subject patterns within the network's own federated.{id}. scope", () => {
    const policy = PolicySchema.parse({
      federated: {
        networks: [{
          id: "research-collab", leaf_node: "leaf", peers: [],
          accept_subjects: [
            "federated.research-collab.tasks.code-review.*",
            "federated.research-collab.>",
          ],
          deny_subjects: ["federated.research-collab.tasks.*.private.*"],
          announce_capabilities: [], max_hop: 0,
        }],
      },
    });
    expect(policy.federated?.networks[0]?.accept_subjects).toHaveLength(2);
  });

  test("federated block plus principals + roles parses cleanly together", () => {
    const policy = PolicySchema.parse({
      principals: [{
        id: "luna", home_operator: "andreas", home_stack: "andreas/research",
        role: ["operator"], trust: [],
      }],
      roles: [{ id: "operator", capabilities: ["deploy.staging"] }],
      federated: {
        networks: [{
          id: "research-collab", leaf_node: "leaf",
          peers: [{ operator_id: "jcfischer", stack_id: "jcfischer/sage-host", operator_pubkey: PEER_PUBKEY_C }],
          accept_subjects: ["federated.research-collab.>"],
          deny_subjects: [],
          announce_capabilities: ["code-review.typescript"],
          max_hop: 1,
        }],
      },
    });
    expect(policy.principals).toHaveLength(1);
    expect(policy.federated?.networks).toHaveLength(1);
  });
});
