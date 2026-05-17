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
  isOperatorPrincipal,
} from "../resolve-access";
import {
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
} from "../policy-gate";
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
      home_operator: "andreas",
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
      home_operator: "andreas",
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
          home_operator: "andreas",
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
