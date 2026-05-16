/**
 * IAW Phase C.2b-242a (cortex#296) — parallel-mode plumbing tests.
 *
 * Unit-tests the `PlatformPrincipalIndex` + `runParallelModeChecks`
 * helpers in `src/common/policy/parallel-mode.ts`. The adapter-side
 * tests (discord/mattermost/slack) cover the same surface through
 * the adapter; these tests pin the module's behaviour in isolation.
 */

import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "../engine";
import {
  PlatformPrincipalIndex,
  buildKeywordCapabilityChecks,
  buildPlatformPrincipalIndex,
  buildToolCapabilityChecks,
  checkCapabilityViaEngine,
  defaultParallelModeSovereignty,
  mergeCapabilityDecision,
  runParallelModeChecks,
} from "../parallel-mode";
import { PolicySchema } from "../../types/cortex-config";

describe("PlatformPrincipalIndex", () => {
  test("resolves a (platform, id) tuple to the declaring principal id", () => {
    const policy = PolicySchema.parse({
      principals: [
        {
          id: "mike",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { discord: ["123", "456"], slack: ["U_MIKE"] },
        },
        {
          id: "alice",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { discord: ["789"] },
        },
      ],
      roles: [{ id: "user", capabilities: ["keyword.chat"] }],
    });
    const index = new PlatformPrincipalIndex(policy.principals);
    expect(index.resolve("discord", "123")).toBe("mike");
    expect(index.resolve("discord", "456")).toBe("mike");
    expect(index.resolve("slack", "U_MIKE")).toBe("mike");
    expect(index.resolve("discord", "789")).toBe("alice");
    expect(index.resolve("discord", "nonexistent")).toBeUndefined();
    expect(index.size).toBe(4);
  });

  test("buildPlatformPrincipalIndex returns undefined for empty policy", () => {
    expect(buildPlatformPrincipalIndex(undefined)).toBeUndefined();
    const empty = PolicySchema.parse({ principals: [], roles: [] });
    expect(buildPlatformPrincipalIndex(empty)).toBeUndefined();
  });

  test("buildPlatformPrincipalIndex returns index when principals declared", () => {
    const policy = PolicySchema.parse({
      principals: [
        {
          id: "luna",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["operator"],
          trust: [],
          platform_ids: { discord: ["BOT_LUNA"] },
        },
      ],
      roles: [{ id: "operator", capabilities: ["operator"] }],
    });
    const index = buildPlatformPrincipalIndex(policy);
    expect(index?.resolve("discord", "BOT_LUNA")).toBe("luna");
  });
});

describe("checkCapabilityViaEngine", () => {
  const engine = new PolicyEngine({
    principals: [
      {
        id: "mike",
        home_operator: "andreas",
        home_stack: "andreas/meta-factory",
        role: ["user"],
        trust: [],
      },
    ],
    roles: [{ id: "user", capabilities: ["keyword.chat"] }],
  });
  const sov = defaultParallelModeSovereignty();

  test("returns allow when capability granted", () => {
    expect(checkCapabilityViaEngine(engine, "mike", "keyword.chat", sov)).toEqual({
      allow: true,
      reason: "capability_granted",
    });
  });

  test("returns deny with insufficient_role when missing capability", () => {
    expect(checkCapabilityViaEngine(engine, "mike", "keyword.team", sov)).toEqual({
      allow: false,
      reason: "insufficient_role:keyword.team",
    });
  });

  test("returns deny with unknown_principal when principalId is undefined", () => {
    expect(checkCapabilityViaEngine(engine, undefined, "keyword.chat", sov)).toEqual({
      allow: false,
      reason: "unknown_principal",
    });
  });

  test("returns deny with unknown_principal when principal not in engine", () => {
    expect(checkCapabilityViaEngine(engine, "ghost", "keyword.chat", sov)).toEqual({
      allow: false,
      reason: "unknown_principal",
    });
  });
});

describe("mergeCapabilityDecision (§9.1 intersection-wins)", () => {
  test("both allow → effective allow, no disagreement", () => {
    const merged = mergeCapabilityDecision(
      "keyword.chat",
      { allow: true, reason: "legacy_allow" },
      { allow: true, reason: "capability_granted" },
    );
    expect(merged.effective.allow).toBe(true);
    expect(merged.disagreement).toBeUndefined();
  });

  test("both deny → effective deny, no disagreement", () => {
    const merged = mergeCapabilityDecision(
      "keyword.chat",
      { allow: false, reason: "legacy_deny" },
      { allow: false, reason: "unknown_principal" },
    );
    expect(merged.effective.allow).toBe(false);
    expect(merged.disagreement).toBeUndefined();
  });

  test("legacy allow + new deny → effective deny + disagreement", () => {
    const merged = mergeCapabilityDecision(
      "keyword.chat",
      { allow: true, reason: "legacy_allow" },
      { allow: false, reason: "unknown_principal" },
    );
    expect(merged.effective.allow).toBe(false);
    expect(merged.disagreement).toEqual({
      legacyDecision: "allow",
      legacyReason: "legacy_allow",
      newDecision: "deny",
      newReason: "unknown_principal",
      effectiveDecision: "deny",
    });
  });

  test("legacy deny + new allow → effective deny + disagreement", () => {
    const merged = mergeCapabilityDecision(
      "keyword.chat",
      { allow: false, reason: "legacy_deny" },
      { allow: true, reason: "capability_granted" },
    );
    expect(merged.effective.allow).toBe(false);
    expect(merged.disagreement?.effectiveDecision).toBe("deny");
  });
});

describe("runParallelModeChecks", () => {
  test("emits one merged decision per check, in input order", () => {
    const policy = PolicySchema.parse({
      principals: [
        {
          id: "mike",
          home_operator: "andreas",
          home_stack: "andreas/meta-factory",
          role: ["user"],
          trust: [],
          platform_ids: { discord: ["U123"] },
        },
      ],
      roles: [{ id: "user", capabilities: ["keyword.chat"] }],
    });
    const engine = new PolicyEngine({
      principals: policy.principals.map((p) => ({
        id: p.id,
        home_operator: p.home_operator,
        home_stack: p.home_stack,
        role: p.role,
        trust: p.trust,
      })),
      roles: policy.roles,
    });
    const index = new PlatformPrincipalIndex(policy.principals);
    const checks = buildKeywordCapabilityChecks({
      features: { chat: true, async: true, team: false },
    });
    const result = runParallelModeChecks({
      engine,
      index,
      platform: "discord",
      platformAuthorId: "U123",
      sovereignty: defaultParallelModeSovereignty(),
      checks,
    });
    expect(result.principalId).toBe("mike");
    expect(result.decisions.length).toBe(3);
    expect(result.decisions.map((d) => d.capability)).toEqual([
      "keyword.chat",
      "keyword.async",
      "keyword.team",
    ]);
    // keyword.chat: legacy allow, new allow → no disagreement
    expect(result.decisions[0]?.disagreement).toBeUndefined();
    // keyword.async: legacy allow, new deny (no grant) → DISAGREEMENT
    expect(result.decisions[1]?.disagreement?.effectiveDecision).toBe("deny");
    // keyword.team: legacy deny, new deny → no disagreement
    expect(result.decisions[2]?.disagreement).toBeUndefined();
  });
});

describe("buildKeywordCapabilityChecks", () => {
  test("emits one check per feature; includes operator when supplied", () => {
    const checks = buildKeywordCapabilityChecks({
      features: { chat: true, async: false, team: true },
      isOperator: true,
    });
    expect(checks.map((c) => c.capability)).toEqual([
      "keyword.chat",
      "keyword.async",
      "keyword.team",
      "operator",
    ]);
    expect(checks[0]?.legacy.allow).toBe(true);
    expect(checks[1]?.legacy.allow).toBe(false);
    expect(checks[3]?.legacy.allow).toBe(true);
  });

  test("omits operator check when isOperator is undefined", () => {
    const checks = buildKeywordCapabilityChecks({
      features: { chat: true, async: false, team: false },
    });
    expect(checks.length).toBe(3);
    expect(checks.find((c) => c.capability === "operator")).toBeUndefined();
  });
});

describe("buildToolCapabilityChecks", () => {
  test("inverts deny-list against canonical tool inventory", () => {
    const inv = ["Bash", "Edit", "Write", "Read"];
    const checks = buildToolCapabilityChecks(inv, ["Edit", "Write"]);
    expect(checks.map((c) => c.capability)).toEqual([
      "tool.bash",
      "tool.edit",
      "tool.write",
      "tool.read",
    ]);
    expect(checks[0]?.legacy.allow).toBe(true); // bash allowed
    expect(checks[1]?.legacy.allow).toBe(false); // edit denied
    expect(checks[2]?.legacy.allow).toBe(false); // write denied
    expect(checks[3]?.legacy.allow).toBe(true); // read allowed
  });

  test("undefined deny-list → all tools allowed", () => {
    const checks = buildToolCapabilityChecks(["Bash", "Read"], undefined);
    expect(checks.every((c) => c.legacy.allow)).toBe(true);
  });
});
