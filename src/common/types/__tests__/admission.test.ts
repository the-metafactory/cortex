/**
 * R26 P1 (cortex#1371) — tests for the `policy.admission` config schema +
 * limit resolution (`admission.ts`), and its integration into `PolicySchema`
 * (optional field, cross-ref checks, inertness of the absent block).
 */

import { describe, expect, test } from "bun:test";
import {
  AdmissionLimitsSchema,
  AdmissionPolicySchema,
  ANONYMOUS_ADMISSION_CEILING,
  clampAnonymousLimits,
  resolveAdmissionLimits,
} from "../admission";
import { PolicySchema } from "../cortex-config";

describe("AdmissionLimitsSchema", () => {
  test("accepts any single bound", () => {
    expect(AdmissionLimitsSchema.safeParse({ per_minute: 6 }).success).toBe(true);
    expect(AdmissionLimitsSchema.safeParse({ max_concurrent: 3 }).success).toBe(true);
  });

  test("rejects an EMPTY bundle — {} must not masquerade as 'limited'", () => {
    expect(AdmissionLimitsSchema.safeParse({}).success).toBe(false);
  });

  test("rejects unknown keys, zero, and negative values", () => {
    expect(AdmissionLimitsSchema.safeParse({ per_second: 1 }).success).toBe(false);
    expect(AdmissionLimitsSchema.safeParse({ per_minute: 0 }).success).toBe(false);
    expect(AdmissionLimitsSchema.safeParse({ per_minute: -5 }).success).toBe(false);
    expect(AdmissionLimitsSchema.safeParse({ per_minute: 1.5 }).success).toBe(false);
  });
});

describe("AdmissionPolicySchema", () => {
  test("accepts the design §4.1 reference shape", () => {
    const parsed = AdmissionPolicySchema.safeParse({
      stack: { max_concurrent: 8, per_minute: 30 },
      defaults: { per_minute: 6, per_hour: 60, max_concurrent: 3 },
      roles: { principal: { per_minute: 20, max_concurrent: 6 }, surface: { per_minute: 10 } },
      principals: [{ id: "amt-surface", per_minute: 12, max_concurrent: 2 }],
      anonymous: { per_minute: 2, max_concurrent: 1 },
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects unknown top-level keys (strict)", () => {
    expect(
      AdmissionPolicySchema.safeParse({ stacks: { per_minute: 1 } }).success,
    ).toBe(false);
  });

  test("principal override requires an id and at least one bound", () => {
    expect(
      AdmissionPolicySchema.safeParse({ principals: [{ id: "x" }] }).success,
    ).toBe(false);
    expect(
      AdmissionPolicySchema.safeParse({ principals: [{ per_minute: 1 }] }).success,
    ).toBe(false);
  });
});

describe("resolveAdmissionLimits — principals > roles (most permissive) > defaults, per field", () => {
  const admission = AdmissionPolicySchema.parse({
    defaults: { per_minute: 2, max_concurrent: 1 },
    roles: {
      basic: { per_minute: 4 },
      power: { per_minute: 8, max_concurrent: 4 },
    },
    principals: [{ id: "vip", per_minute: 20 }],
  });

  test("defaults apply when nothing more specific matches", () => {
    expect(
      resolveAdmissionLimits(admission, {
        principalId: "nobody",
        anonymous: false,
        roles: [],
      }),
    ).toEqual({ per_minute: 2, max_concurrent: 1 });
  });

  test("most permissive value wins across multiple roles", () => {
    expect(
      resolveAdmissionLimits(admission, {
        principalId: "dev",
        anonymous: false,
        roles: ["basic", "power"],
      }),
    ).toEqual({ per_minute: 8, max_concurrent: 4 });
  });

  test("principal override wins per FIELD; unset fields fall through", () => {
    // vip sets only per_minute — max_concurrent falls through role → default.
    expect(
      resolveAdmissionLimits(admission, {
        principalId: "vip",
        anonymous: false,
        roles: ["basic"],
      }),
    ).toEqual({ per_minute: 20, max_concurrent: 1 });
  });

  test("returns undefined when NOTHING resolves (tier inert)", () => {
    const bare = AdmissionPolicySchema.parse({
      principals: [{ id: "someone-else", per_minute: 1 }],
    });
    expect(
      resolveAdmissionLimits(bare, {
        principalId: "unlimited",
        anonymous: false,
        roles: [],
      }),
    ).toBeUndefined();
  });

  test("anonymous short-circuits to the clamped anonymous lane, ignoring defaults", () => {
    expect(
      resolveAdmissionLimits(admission, {
        principalId: "public",
        anonymous: true,
        roles: [],
      }),
    ).toEqual({
      per_minute: ANONYMOUS_ADMISSION_CEILING.per_minute,
      max_concurrent: ANONYMOUS_ADMISSION_CEILING.max_concurrent,
    });
  });
});

describe("clampAnonymousLimits — the built-in ceiling (design §3.1)", () => {
  test("absent config ⇒ the ceiling verbatim", () => {
    expect(clampAnonymousLimits(undefined)).toEqual({
      per_minute: 2,
      max_concurrent: 1,
    });
  });

  test("config can TIGHTEN but never RAISE the capped fields", () => {
    expect(clampAnonymousLimits({ per_minute: 1 })).toEqual({
      per_minute: 1,
      max_concurrent: 1,
    });
    expect(clampAnonymousLimits({ per_minute: 100, max_concurrent: 9 })).toEqual({
      per_minute: 2,
      max_concurrent: 1,
    });
  });

  test("extra windows pass through (they only AND-tighten)", () => {
    expect(clampAnonymousLimits({ per_minute: 2, per_day: 10 })).toEqual({
      per_minute: 2,
      max_concurrent: 1,
      per_day: 10,
    });
  });
});

describe("PolicySchema integration — the CO-4 inertness + cross-refs", () => {
  const basePolicy = {
    principals: [
      {
        id: "andreas",
        home_principal: "andreas",
        home_stack: "andreas/work",
        role: ["principal"],
        trust: [],
      },
    ],
    roles: [{ id: "principal", capabilities: ["dispatch.pylon"] }],
  };

  test("absent admission block parses to undefined (limiter fully inert)", () => {
    const parsed = PolicySchema.parse(basePolicy);
    expect(parsed.admission).toBeUndefined();
  });

  test("a valid admission block parses through PolicySchema", () => {
    const parsed = PolicySchema.parse({
      ...basePolicy,
      admission: {
        stack: { max_concurrent: 8, per_minute: 30 },
        roles: { principal: { per_minute: 20 } },
        principals: [{ id: "andreas", per_minute: 12 }],
      },
    });
    expect(parsed.admission?.stack?.per_minute).toBe(30);
  });

  test("admission.roles key must reference a declared role", () => {
    const result = PolicySchema.safeParse({
      ...basePolicy,
      admission: { roles: { ghost: { per_minute: 1 } } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "admission.roles.ghost")).toBe(true);
    }
  });

  test("admission.principals[].id must reference a declared principal", () => {
    const result = PolicySchema.safeParse({
      ...basePolicy,
      admission: { principals: [{ id: "ghost", per_minute: 1 }] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join(".") === "admission.principals.0.id"),
      ).toBe(true);
    }
  });

  test("duplicate admission.principals ids are rejected", () => {
    const result = PolicySchema.safeParse({
      ...basePolicy,
      admission: {
        principals: [
          { id: "andreas", per_minute: 1 },
          { id: "andreas", per_minute: 2 },
        ],
      },
    });
    expect(result.success).toBe(false);
  });
});
