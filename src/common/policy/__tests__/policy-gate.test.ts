/**
 * v2.0.0 cutover (cortex#297) — direct unit tests for policy-gate primitives.
 *
 * PR #310 r1 M-2 caught: the new helpers shipped with zero direct test
 * coverage. These tests cover the platform-id lookup index + principal
 * registry factories at the function level, independent of adapter
 * call-sites. Combined with `resolve-access.test.ts` they pin the new
 * authorization core that replaced the deleted `parallel-mode.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  PlatformPrincipalIndex,
  buildPlatformPrincipalIndex,
  buildPrincipalRegistry,
  defaultPolicySovereignty,
} from "../policy-gate";
import type { Policy, PolicyPrincipal } from "../../types/cortex-config";

function principal(overrides: Partial<PolicyPrincipal> = {}): PolicyPrincipal {
  return {
    id: "luna",
    home_operator: "andreas",
    home_stack: "andreas/meta-factory",
    role: [],
    trust: [],
    platform_ids: {},
    ...overrides,
  };
}

describe("PlatformPrincipalIndex", () => {
  test("resolves (platform, id) → principal id when the principal claims the tuple", () => {
    const idx = new PlatformPrincipalIndex([
      principal({ id: "luna", platform_ids: { discord: ["1487180524542890144"] } }),
    ]);
    expect(idx.resolve("discord", "1487180524542890144")).toBe("luna");
  });

  test("returns undefined for unknown platform", () => {
    const idx = new PlatformPrincipalIndex([
      principal({ id: "luna", platform_ids: { discord: ["1487180524542890144"] } }),
    ]);
    expect(idx.resolve("mattermost", "1487180524542890144")).toBeUndefined();
  });

  test("returns undefined for unknown id on a known platform", () => {
    const idx = new PlatformPrincipalIndex([
      principal({ id: "luna", platform_ids: { discord: ["1487180524542890144"] } }),
    ]);
    expect(idx.resolve("discord", "9999")).toBeUndefined();
  });

  test("returns undefined for an empty index", () => {
    const idx = new PlatformPrincipalIndex([]);
    expect(idx.resolve("discord", "1487180524542890144")).toBeUndefined();
    expect(idx.size).toBe(0);
  });

  test("indexes multiple platforms on the same principal (operator on Discord + Slack)", () => {
    const idx = new PlatformPrincipalIndex([
      principal({
        id: "operator",
        platform_ids: {
          discord: ["1134325176796987522"],
          slack: ["U01234"],
        },
      }),
    ]);
    expect(idx.resolve("discord", "1134325176796987522")).toBe("operator");
    expect(idx.resolve("slack", "U01234")).toBe("operator");
    expect(idx.size).toBe(2);
  });

  test("indexes multiple principals on different ids", () => {
    const idx = new PlatformPrincipalIndex([
      principal({ id: "luna", platform_ids: { discord: ["1487180524542890144"] } }),
      principal({ id: "echo", platform_ids: { discord: ["1497872105067253800"] } }),
    ]);
    expect(idx.resolve("discord", "1487180524542890144")).toBe("luna");
    expect(idx.resolve("discord", "1497872105067253800")).toBe("echo");
  });

  test("PR #310 r1 N-1 — uses `:` separator so prefix-aliased platform names don't collide", () => {
    // Without a separator, platform `disco` + id `rd123` would alias to
    // the same key as platform `discord` + id `123`. With `:`, they don't.
    const idx = new PlatformPrincipalIndex([
      principal({ id: "alpha", platform_ids: { disco: ["rd123"] } }),
      principal({ id: "beta", platform_ids: { discord: ["123"] } }),
    ]);
    expect(idx.resolve("disco", "rd123")).toBe("alpha");
    expect(idx.resolve("discord", "123")).toBe("beta");
    // Both index entries must coexist
    expect(idx.size).toBe(2);
  });

  test("size reports the total (platform, id) tuple count", () => {
    const idx = new PlatformPrincipalIndex([
      principal({
        id: "operator",
        platform_ids: {
          discord: ["1134325176796987522"],
          slack: ["U01234", "U05678"],
        },
      }),
      principal({ id: "luna", platform_ids: { discord: ["1487180524542890144"] } }),
    ]);
    expect(idx.size).toBe(4);
  });
});

describe("buildPlatformPrincipalIndex", () => {
  test("returns undefined when policy is undefined", () => {
    expect(buildPlatformPrincipalIndex(undefined)).toBeUndefined();
  });

  test("returns undefined when policy.principals is empty", () => {
    const policy: Policy = { principals: [], roles: [] };
    expect(buildPlatformPrincipalIndex(policy)).toBeUndefined();
  });

  test("returns a populated index when principals are declared", () => {
    const policy: Policy = {
      principals: [
        principal({ id: "luna", platform_ids: { discord: ["1487180524542890144"] } }),
      ],
      roles: [],
    };
    const idx = buildPlatformPrincipalIndex(policy);
    expect(idx).toBeDefined();
    expect(idx?.resolve("discord", "1487180524542890144")).toBe("luna");
  });
});

describe("buildPrincipalRegistry", () => {
  test("returns undefined when policy is undefined", () => {
    expect(buildPrincipalRegistry(undefined)).toBeUndefined();
  });

  test("returns undefined when policy.principals is empty", () => {
    const policy: Policy = { principals: [], roles: [] };
    expect(buildPrincipalRegistry(policy)).toBeUndefined();
  });

  test("returns a Map keyed by principal.id", () => {
    const luna = principal({ id: "luna" });
    const echo = principal({ id: "echo" });
    const policy: Policy = {
      principals: [luna, echo],
      roles: [],
    };
    const reg = buildPrincipalRegistry(policy);
    expect(reg).toBeDefined();
    expect(reg?.get("luna")).toBe(luna);
    expect(reg?.get("echo")).toBe(echo);
    expect(reg?.get("nobody")).toBeUndefined();
  });
});

describe("defaultPolicySovereignty", () => {
  test("returns local-only / NZ by default", () => {
    const s = defaultPolicySovereignty();
    expect(s.classification).toBe("local");
    expect(s.data_residency).toBe("NZ");
    expect(s.max_hop).toBe(0);
    expect(s.frontier_ok).toBe(false);
    expect(s.model_class).toBe("local-only");
  });

  test("accepts a custom data_residency", () => {
    const s = defaultPolicySovereignty("EU");
    expect(s.data_residency).toBe("EU");
    expect(s.classification).toBe("local");
  });
});
