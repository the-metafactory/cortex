/**
 * v2.0.0 cutover (cortex#297) — direct unit tests for resolvePolicyAccess.
 *
 * PR #310 r1 M-2 fix. After cortex#297, `resolvePolicyAccess` is the SOLE
 * authorization decision for every inbound message on every adapter. These
 * tests pin the function-level contract independently of adapter call sites.
 */

import { describe, expect, test } from "bun:test";

import { DID_RE } from "@the-metafactory/myelin/identity";
import {
  resolvePolicyAccess,
  anonOnboardingAccess,
  PUBLIC_ORIGINATOR_DID,
  isOperatorPrincipal,
} from "../resolve-access";
import {
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
  defaultPolicySovereignty,
} from "../policy-gate";
import { CLAUDE_TOOL_INVENTORY } from "../tool-inventory";
import {
  policyEngineFromConfig,
  buildPublicPrincipalEntries,
  PUBLIC_PRINCIPAL_ID,
  PUBLIC_ROLE_ID,
} from "../factory";
import type { Policy } from "../../types/cortex-config";
import type { InboundMessage } from "../../../adapters/types";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "discord",
    instanceId: "111111111111111111",
    authorId: "666666666666666666",
    authorName: "andreas",
    content: "hello",
    channelId: "999999999999999999",
    timestamp: new Date("2026-05-17T00:00:00Z"),
    ...overrides,
  } as InboundMessage;
}

function buildHarness(policy: Policy) {
  return {
    engine: policyEngineFromConfig(policy),
    index: buildPlatformPrincipalIndex(policy),
    registry: buildPrincipalRegistry(policy),
  };
}

// Operator principal with all keyword + tool capabilities + operator short-circuit.
const OPERATOR_POLICY: Policy = {
  principals: [
    {
      id: "operator",
      home_principal: "andreas",
      home_stack: "andreas/meta-factory",
      role: ["operator"],
      trust: [],
      platform_ids: { discord: ["666666666666666666"] },
    },
  ],
  roles: [
    {
      id: "operator",
      capabilities: [
        "keyword.chat",
        "keyword.async",
        "keyword.team",
        "operator",
        "tool.bash",
        "tool.read",
        "tool.grep",
        "tool.glob",
      ],
    },
  ],
};

const USER_POLICY: Policy = {
  principals: [
    {
      id: "mike",
      home_principal: "andreas",
      home_stack: "andreas/meta-factory",
      role: ["user"],
      trust: [],
      platform_ids: { discord: ["555555555555555555"] },
    },
  ],
  roles: [
    {
      id: "user",
      capabilities: ["keyword.chat", "tool.read", "tool.grep"],
    },
  ],
};

describe("resolvePolicyAccess — no-policy deny path", () => {
  test("returns DENY_NO_POLICY when engine is undefined", () => {
    const result = resolvePolicyAccess({
      msg: msg(),
      engine: undefined,
      index: buildPlatformPrincipalIndex(USER_POLICY),
      registry: buildPrincipalRegistry(USER_POLICY),
    });
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toContain("no policy.principals[]");
    expect(result.denyReason).toContain("migrate-config.ts");
  });

  test("returns DENY_NO_POLICY when index is undefined", () => {
    const result = resolvePolicyAccess({
      msg: msg(),
      engine: policyEngineFromConfig(USER_POLICY),
      index: undefined,
      registry: buildPrincipalRegistry(USER_POLICY),
    });
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toContain("migrate-config.ts");
  });

  test("threads isDM through deny path", () => {
    const result = resolvePolicyAccess({
      msg: msg({ isDM: true }),
      engine: undefined,
      index: undefined,
      registry: undefined,
    });
    expect(result.allowed).toBe(false);
    expect(result.isDM).toBe(true);
  });
});

describe("resolvePolicyAccess — unknown principal deny path", () => {
  test("denies when no principal claims the (platform, authorId) tuple", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "9999999999999999" }),
      ...buildHarness(USER_POLICY),
    });
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toContain("not set up to respond");
    expect(result.denyReason).toContain("policy.principals[].platform_ids");
  });

  // cortex#1165 — the unmapped-sender deny must carry the stable `unmapped_sender`
  // code so the open-onboarding gate can key off the category, not the prose.
  test("stamps denyCode=unmapped_sender on the unknown-principal deny", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "9999999999999999" }),
      ...buildHarness(USER_POLICY),
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("unmapped_sender");
  });

  test("no-policy deny carries denyCode=no_policy (NOT unmapped_sender)", () => {
    const result = resolvePolicyAccess({
      msg: msg(),
      engine: undefined,
      index: undefined,
      registry: undefined,
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("no_policy");
  });

  test("lockout deny (recognized principal, zero keyword caps) carries denyCode=lockout", () => {
    const lockoutPolicy: Policy = {
      principals: [
        {
          id: "muted",
          home_principal: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["muted"],
          trust: [],
          platform_ids: { discord: ["555000111222333444"] },
        },
      ],
      // role exists but grants NO keyword.* and NOT operator
      roles: [{ id: "muted", capabilities: ["tool.read"] }],
    };
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555000111222333444" }),
      ...buildHarness(lockoutPolicy),
    });
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("lockout");
  });
});

describe("anonOnboardingAccess — zero-authority anonymous principal (cortex#1165)", () => {
  test("allows chat ONLY — async + team stay false (no privileged keywords)", () => {
    const result = anonOnboardingAccess(msg({ authorId: "555555555555555555" }));
    expect(result.allowed).toBe(true);
    expect(result.features.chat).toBe(true);
    expect(result.features.async).toBe(false);
    expect(result.features.team).toBe(false);
  });

  test("is NOT trusted — the inbound prompt-injection filter stays armed", () => {
    const result = anonOnboardingAccess(msg());
    // trusted must be explicitly false (not merely undefined) — a stranger is
    // the least-trusted sender; the filter's trust gate must never let it pass.
    expect(result.trusted).toBe(false);
  });

  test("restricts EVERY tool in the canonical inventory (zero tool authority)", () => {
    const result = anonOnboardingAccess(msg());
    // The full inventory is restricted — no tool is granted.
    expect(result.toolRestrictions).toEqual([...CLAUDE_TOOL_INVENTORY]);
    // Spot-check the dangerous ones explicitly.
    expect(result.toolRestrictions).toContain("Bash");
    expect(result.toolRestrictions).toContain("Write");
    expect(result.toolRestrictions).toContain("Edit");
    expect(result.toolRestrictions).toContain("Read");
  });

  test("grants NO skills and NO dir restrictions (inherits most-restrictive defaults), bashGuard ON", () => {
    const result = anonOnboardingAccess(msg());
    expect(result.allowedSkills).toBeUndefined();
    expect(result.dirRestrictions).toBeUndefined();
    expect(result.bashGuard).toBe(true);
  });

  test("marks the decision as anon, keeping the per-sender id as an AUDIT label only", () => {
    const result = anonOnboardingAccess(msg({ platform: "discord", authorId: "555555555555555555" }));
    expect(result.anonPrincipal).toBe(true);
    // cortex#1167 — this is an audit label, NOT the authority. Authority is the
    // single `public` principal (proven in the buildPublicPrincipalEntries +
    // dispatch-handler round-trip tests).
    expect(result.anonPrincipalId).toBe("anon:discord:555555555555555555");
  });

  test("threads isDM through when the inbound was a DM", () => {
    expect(anonOnboardingAccess(msg({ isDM: true })).isDM).toBe(true);
    expect(anonOnboardingAccess(msg({ isDM: false })).isDM).toBeUndefined();
  });

  // cortex#1167 review MAJOR — explicit allowlist (tool confinement is an
  // allowlist, NOT an allow-by-default deny-list).
  test("carries an EXPLICIT tool allowlist equal to the persona list", () => {
    const result = anonOnboardingAccess(msg(), ["Read"]);
    expect(result.allowedTools).toEqual(["Read"]);
  });

  test("an unlisted tool (and any mcp__*) is NOT in the allowlist", () => {
    const result = anonOnboardingAccess(msg(), ["Read"]);
    expect(result.allowedTools).not.toContain("Bash");
    expect(result.allowedTools).not.toContain("Write");
    // The crux of the MAJOR: MCP tools are NOT in the inventory deny-list, so
    // only the allowlist keeps them out. Prove they are not allowed.
    expect(result.allowedTools!.some((t) => t.startsWith("mcp__"))).toBe(false);
  });

  test("falls back to the most-restrictive ['Read'] when no allowlist passed", () => {
    expect(anonOnboardingAccess(msg()).allowedTools).toEqual(["Read"]);
  });

  test("coerces an EMPTY allowlist up to ['Read'] (never allow-by-default)", () => {
    // An empty `--allowedTools` would mean allow-by-default at the CC layer; a
    // stranger must never get that, so an empty list is coerced to Read-only.
    expect(anonOnboardingAccess(msg(), []).allowedTools).toEqual(["Read"]);
  });
});

describe("PUBLIC_ORIGINATOR_DID — the public principal's wire identity (cortex#1167)", () => {
  test("is `did:mf:public` and DID-grammar valid", () => {
    expect(PUBLIC_ORIGINATOR_DID).toBe("did:mf:public");
    expect(DID_RE.test(PUBLIC_ORIGINATOR_DID)).toBe(true);
  });
});

describe("buildPublicPrincipalEntries — single minimal-privilege public principal (cortex#1167)", () => {
  const HOME_PRINCIPAL = "andreas";
  const HOME_STACK = "andreas/meta-factory";

  test("no flagged agents → NO public principal registered (unmapped stays denied)", () => {
    const { principals, roles } = buildPublicPrincipalEntries([], HOME_PRINCIPAL, HOME_STACK);
    expect(principals).toEqual([]);
    expect(roles).toEqual([]);
  });

  test("grants EXACTLY dispatch.<agentId> per flagged agent, and nothing else", () => {
    const { principals, roles } = buildPublicPrincipalEntries(["pier"], HOME_PRINCIPAL, HOME_STACK);
    expect(principals).toHaveLength(1);
    expect(principals[0]!.id).toBe(PUBLIC_PRINCIPAL_ID);
    expect(principals[0]!.role).toEqual([PUBLIC_ROLE_ID]);
    // No platform_ids → never resolved via the (platform, authorId) index.
    expect(principals[0]!.platform_ids).toBeUndefined();
    expect(roles).toHaveLength(1);
    expect(roles[0]!.capabilities).toEqual(["dispatch.pier"]);
  });

  test("multiple flagged agents → one capability each", () => {
    const { roles } = buildPublicPrincipalEntries(["pier", "concierge"], HOME_PRINCIPAL, HOME_STACK);
    expect(roles[0]!.capabilities).toEqual(["dispatch.pier", "dispatch.concierge"]);
  });

  // The security crux: wire the synthetic entries into a real engine and prove
  // `public` PASSES dispatch.pier but is DENIED everything else.
  function engineWithPublic(flagged: string[]) {
    const policy: Policy = {
      principals: [OPERATOR_POLICY.principals[0]!],
      roles: OPERATOR_POLICY.roles,
    };
    return policyEngineFromConfig(policy, flagged)!;
  }
  const sov = defaultPolicySovereignty();

  test("`public` is GRANTED dispatch.pier (functional end-to-end at the listener)", () => {
    const engine = engineWithPublic(["pier"]);
    expect(engine.check(PUBLIC_PRINCIPAL_ID, { capability: "dispatch.pier", sovereignty: sov }).allow).toBe(true);
  });

  test("`public` is DENIED dispatch to a NON-flagged agent (Luna)", () => {
    const engine = engineWithPublic(["pier"]);
    expect(engine.check(PUBLIC_PRINCIPAL_ID, { capability: "dispatch.luna", sovereignty: sov }).allow).toBe(false);
  });

  test("`public` is DENIED operator, every tool, every keyword, admit, and bus", () => {
    const engine = engineWithPublic(["pier"]);
    for (const cap of [
      "operator",
      "keyword.chat", "keyword.async", "keyword.team",
      "tool.read", "tool.bash", "tool.write", "tool.edit",
      "admit", "network.admit",
      "bus.publish", "publish",
    ]) {
      expect(engine.check(PUBLIC_PRINCIPAL_ID, { capability: cap, sovereignty: sov }).allow).toBe(false);
    }
  });

  test("with NO flagged agents, `public` is an UNKNOWN principal (zero authority, denied everything)", () => {
    const engine = engineWithPublic([]);
    expect(engine.check(PUBLIC_PRINCIPAL_ID, { capability: "dispatch.pier", sovereignty: sov }).allow).toBe(false);
    expect(engine.check(PUBLIC_PRINCIPAL_ID, { capability: "operator", sovereignty: sov }).allow).toBe(false);
  });
});

describe("resolvePolicyAccess — happy path (user)", () => {
  test("user principal with keyword.chat allows chat feature only", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555555555555555555" }),
      ...buildHarness(USER_POLICY),
    });
    expect(result.allowed).toBe(true);
    expect(result.features.chat).toBe(true);
    expect(result.features.async).toBe(false);
    expect(result.features.team).toBe(false);
  });

  test("cortex#741: a recognized NON-operator (peer) principal is NOT trusted", () => {
    // The content-filter trust gate keys off `trusted`. A recognized peer
    // principal must NOT carry it — they keep the prompt-injection hard block.
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555555555555555555" }),
      ...buildHarness(USER_POLICY),
    });
    expect(result.allowed).toBe(true);
    expect(result.trusted).toBeUndefined();
  });

  test("user without async or team caps gets toolRestrictions for ungranted tools", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555555555555555555" }),
      ...buildHarness(USER_POLICY),
    });
    expect(result.allowed).toBe(true);
    // User has only tool.read + tool.grep granted; everything else (Bash, Edit, Write, etc.) is in toolRestrictions.
    expect(result.toolRestrictions).toContain("Bash");
    expect(result.toolRestrictions).toContain("Edit");
    expect(result.toolRestrictions).not.toContain("Read");
    expect(result.toolRestrictions).not.toContain("Grep");
  });
});

describe("resolvePolicyAccess — operator short-circuit", () => {
  test("operator capability expands features to all-allowed regardless of keyword grants", () => {
    // Build an operator policy that does NOT grant keyword.async / keyword.team
    // explicitly — only `operator`. The short-circuit should still surface
    // async + team as allowed.
    const operatorOnly: Policy = {
      principals: [OPERATOR_POLICY.principals[0]!],
      roles: [
        {
          id: "operator",
          capabilities: ["operator", "keyword.chat", "tool.read"],
        },
      ],
    };
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "666666666666666666" }),
      ...buildHarness(operatorOnly),
    });
    expect(result.allowed).toBe(true);
    expect(result.features.chat).toBe(true);
    expect(result.features.async).toBe(true);
    expect(result.features.team).toBe(true);
  });

  test("cortex#741: an operator-role principal is marked trusted for the content filter", () => {
    // `trusted` is the single signal the dispatch-handler reads to skip the
    // prompt-injection hard block for the operator/home principal. It must be
    // set ONLY for the operator role (conservative boundary) — see the
    // companion peer-principal assertion in the user happy-path block.
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "666666666666666666" }),
      ...buildHarness(OPERATOR_POLICY),
    });
    expect(result.allowed).toBe(true);
    expect(result.trusted).toBe(true);
  });
});

describe("resolvePolicyAccess — session_config selection", () => {
  test("picks session_config.default when not in DM", () => {
    const withSession: Policy = {
      principals: [
        {
          ...USER_POLICY.principals[0]!,
          session_config: {
            default: {
              allowed_dirs: ["~/Developer/grove"],
              bash_guard: true,
            },
            dm: {
              allowed_dirs: ["~/Developer/grove", "~/Developer/cortex"],
              bash_guard: true,
            },
          },
        },
      ],
      roles: USER_POLICY.roles,
    };
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555555555555555555", isDM: false }),
      ...buildHarness(withSession),
    });
    expect(result.dirRestrictions).toEqual(["~/Developer/grove"]);
  });

  test("picks session_config.dm when msg.isDM is true and dm block exists", () => {
    const withSession: Policy = {
      principals: [
        {
          ...USER_POLICY.principals[0]!,
          session_config: {
            default: {
              allowed_dirs: ["~/Developer/grove"],
              bash_guard: true,
            },
            dm: {
              allowed_dirs: ["~/Developer/grove", "~/Developer/cortex"],
              bash_guard: true,
            },
          },
        },
      ],
      roles: USER_POLICY.roles,
    };
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555555555555555555", isDM: true }),
      ...buildHarness(withSession),
    });
    expect(result.dirRestrictions).toEqual([
      "~/Developer/grove",
      "~/Developer/cortex",
    ]);
    expect(result.isDM).toBe(true);
  });

  test("falls back to session_config.default when msg.isDM is true but dm block is absent", () => {
    const withSession: Policy = {
      principals: [
        {
          ...USER_POLICY.principals[0]!,
          session_config: {
            default: {
              allowed_dirs: ["~/Developer/grove"],
              bash_guard: true,
            },
          },
        },
      ],
      roles: USER_POLICY.roles,
    };
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "555555555555555555", isDM: true }),
      ...buildHarness(withSession),
    });
    expect(result.dirRestrictions).toEqual(["~/Developer/grove"]);
  });
});

describe("resolvePolicyAccess — lockout path", () => {
  test("principal with zero keyword capabilities and no operator capability is denied", () => {
    const lockedOutPolicy: Policy = {
      principals: [
        {
          id: "guest",
          home_principal: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["guest"],
          trust: [],
          platform_ids: { discord: ["100000000000000111"] },
        },
      ],
      roles: [
        {
          id: "guest",
          capabilities: ["tool.read"], // Tool grants but no keyword.* and no operator.
        },
      ],
    };
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "100000000000000111" }),
      ...buildHarness(lockedOutPolicy),
    });
    expect(result.allowed).toBe(false);
    expect(result.denyReason).toContain("no keyword capabilities");
    expect(result.denyReason).toContain("keyword.chat");
  });
});

describe("isOperatorPrincipal", () => {
  test("returns true when the resolved principal has the operator capability", () => {
    const { engine, index } = buildHarness(OPERATOR_POLICY);
    expect(isOperatorPrincipal("discord", "666666666666666666", engine, index)).toBe(true);
  });

  test("returns false when the resolved principal lacks the operator capability", () => {
    const { engine, index } = buildHarness(USER_POLICY);
    expect(isOperatorPrincipal("discord", "555555555555555555", engine, index)).toBe(false);
  });

  test("returns false when the (platform, id) tuple resolves to no principal", () => {
    const { engine, index } = buildHarness(USER_POLICY);
    expect(isOperatorPrincipal("discord", "9999", engine, index)).toBe(false);
  });

  test("returns false when engine is undefined (no-policy deployment)", () => {
    expect(isOperatorPrincipal("discord", "666666666666666666", undefined, undefined)).toBe(false);
  });
});

// WEB-2 / B1 — zero-tool airgap: the facilitator-role principal profile mirrors
// the pylon principal in ~/.config/cortex/work/stacks/work.yaml.
// facilitator-role carries `grill` only — no keyword.* and no tool.* capabilities.
// That combination means pylon is locked-out as a sender (correct security posture:
// pylon should never initiate chats; it is dispatched TO by luna).
// The actual dispatch-layer tool enforcement (agentDisallowedTools) is proven in
// dispatch-handler.test.ts; these tests pin the policy-layer lockout contract.
describe("resolvePolicyAccess — facilitator-role: pylon locked-out as sender (WEB-2/B1)", () => {
  const PYLON_POLICY: Policy = {
    principals: [
      {
        id: "pylon",
        home_principal: "andreas",
        home_stack: "andreas/work",
        role: ["facilitator-role"],
        trust: [],
        platform_ids: { discord: ["pylon-test-id"] },
      },
    ],
    roles: [
      {
        // Mirrors policy.roles[facilitator-role] in work.yaml: `grill` ONLY —
        // no keyword.* → pylon cannot initiate chats (lockout as sender).
        // no tool.* → if the lockout path were ever bypassed, all 14 inventory
        // tools would still be denied by policy inversion.
        id: "facilitator-role",
        capabilities: ["grill"],
      },
    ],
  };

  test("facilitator-role with grill-only caps → pylon is locked out as a sender (correct posture)", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "pylon-test-id" }),
      ...buildHarness(PYLON_POLICY),
    });
    // No keyword.* → locked out. Pylon must never be a sender; dispatched TO by luna.
    expect(result.allowed).toBe(false);
    expect(result.denyCode).toBe("lockout");
    expect(result.features.chat).toBe(false);
    expect(result.features.async).toBe(false);
    expect(result.features.team).toBe(false);
  });

  test("operator role with dispatch.pylon → luna CAN dispatch to pylon", () => {
    // luna's operator role includes dispatch.pylon. Prove the engine allows it.
    const operatorPolicy: Policy = {
      principals: [
        {
          id: "luna",
          home_principal: "andreas",
          home_stack: "andreas/work",
          role: ["operator"],
          trust: [],
          platform_ids: { discord: ["666666666666666666"] },
        },
      ],
      roles: [
        {
          id: "operator",
          capabilities: ["operator", "keyword.chat", "keyword.async", "keyword.team", "dispatch.pylon"],
        },
      ],
    };
    const engine = policyEngineFromConfig(operatorPolicy);
    if (engine === undefined) throw new Error("policyEngineFromConfig returned undefined");
    const sovereignty = defaultPolicySovereignty();
    // luna can dispatch to pylon
    expect(engine.check("luna", { capability: "dispatch.pylon", sovereignty }).allow).toBe(true);
    // pylon cannot dispatch to anything (not registered)
    expect(engine.check("pylon", { capability: "dispatch.luna", sovereignty }).allow).toBe(false);
  });
});
