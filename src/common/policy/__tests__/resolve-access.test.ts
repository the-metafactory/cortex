/**
 * v2.0.0 cutover (cortex#297) — direct unit tests for resolvePolicyAccess.
 *
 * PR #310 r1 M-2 fix. After cortex#297, `resolvePolicyAccess` is the SOLE
 * authorization decision for every inbound message on every adapter. These
 * tests pin the function-level contract independently of adapter call sites.
 */

import { describe, expect, test } from "bun:test";

import {
  resolvePolicyAccess,
  anonOnboardingAccess,
  isOperatorPrincipal,
} from "../resolve-access";
import {
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
  defaultPolicySovereignty,
} from "../policy-gate";
import { CLAUDE_TOOL_INVENTORY } from "../tool-inventory";
import { policyEngineFromConfig } from "../factory";
import type { Policy } from "../../types/cortex-config";
import type { InboundMessage } from "../../../adapters/types";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "discord",
    instanceId: "1487023327791808592",
    authorId: "1134325176796987522",
    authorName: "andreas",
    content: "hello",
    channelId: "1487029848164536361",
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
      platform_ids: { discord: ["1134325176796987522"] },
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
      platform_ids: { discord: ["285727653603049472"] },
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
    const result = anonOnboardingAccess(msg({ authorId: "285727653603049472" }));
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

  test("marks the decision as anon with a synthetic, non-registry id", () => {
    const result = anonOnboardingAccess(msg({ platform: "discord", authorId: "285727653603049472" }));
    expect(result.anonPrincipal).toBe(true);
    expect(result.anonPrincipalId).toBe("anon:discord:285727653603049472");
  });

  test("the anon id is NOT resolvable by the policy index/registry — zero authority proven", () => {
    // Prove the anon principal can satisfy NO role-gated check: build a real
    // engine, then confirm neither the synthetic id nor the raw author tuple
    // resolves to any capability.
    const { engine, index } = buildHarness(OPERATOR_POLICY);
    expect(engine).toBeDefined();
    expect(index).toBeDefined();
    const anon = anonOnboardingAccess(msg({ authorId: "285727653603049472" }));
    // 1. The synthetic id is not in the registry → index never produced it,
    //    and the engine denies every capability for an unknown principal.
    for (const cap of ["operator", "keyword.chat", "keyword.async", "keyword.team", "tool.read", "tool.bash"]) {
      expect(engine!.check(anon.anonPrincipalId!, { capability: cap, sovereignty: defaultPolicySovereignty() }).allow).toBe(false);
    }
    // 2. The raw inbound tuple resolves to NO principal id at all.
    expect(index!.resolve("discord", "285727653603049472")).toBeUndefined();
  });

  test("threads isDM through when the inbound was a DM", () => {
    expect(anonOnboardingAccess(msg({ isDM: true })).isDM).toBe(true);
    expect(anonOnboardingAccess(msg({ isDM: false })).isDM).toBeUndefined();
  });
});

describe("resolvePolicyAccess — happy path (user)", () => {
  test("user principal with keyword.chat allows chat feature only", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "285727653603049472" }),
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
      msg: msg({ authorId: "285727653603049472" }),
      ...buildHarness(USER_POLICY),
    });
    expect(result.allowed).toBe(true);
    expect(result.trusted).toBeUndefined();
  });

  test("user without async or team caps gets toolRestrictions for ungranted tools", () => {
    const result = resolvePolicyAccess({
      msg: msg({ authorId: "285727653603049472" }),
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
      msg: msg({ authorId: "1134325176796987522" }),
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
      msg: msg({ authorId: "1134325176796987522" }),
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
      msg: msg({ authorId: "285727653603049472", isDM: false }),
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
      msg: msg({ authorId: "285727653603049472", isDM: true }),
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
      msg: msg({ authorId: "285727653603049472", isDM: true }),
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
    expect(isOperatorPrincipal("discord", "1134325176796987522", engine, index)).toBe(true);
  });

  test("returns false when the resolved principal lacks the operator capability", () => {
    const { engine, index } = buildHarness(USER_POLICY);
    expect(isOperatorPrincipal("discord", "285727653603049472", engine, index)).toBe(false);
  });

  test("returns false when the (platform, id) tuple resolves to no principal", () => {
    const { engine, index } = buildHarness(USER_POLICY);
    expect(isOperatorPrincipal("discord", "9999", engine, index)).toBe(false);
  });

  test("returns false when engine is undefined (no-policy deployment)", () => {
    expect(isOperatorPrincipal("discord", "1134325176796987522", undefined, undefined)).toBe(false);
  });
});
