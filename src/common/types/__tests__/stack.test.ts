/**
 * IAW Phase A.5 — `StackConfigSchema` + `deriveStackId` tests (cortex#113).
 *
 * Two surfaces under test:
 *   1. `StackConfigSchema` — accepts well-formed `{principal}/{stack}` ids and
 *      base32 NKey public keys; rejects uppercase, missing slash, garbage
 *      NKeys, and other shape violations the regexes guard against.
 *   2. `deriveStackId` — explicit `stack:` block wins; otherwise default-
 *      derives `${principal.id}/default`. The total-function contract holds
 *      even when `principal.id` is missing (test-only edge case): falls back
 *      to `default/default` rather than throwing.
 *
 * The schema-side tests live next to the rest of the cortex-config schema
 * tests (`./cortex-config.test.ts`) by file-naming convention, but the
 * `deriveStackId` logic warrants its own test file because the helper has
 * its own module — `../stack.ts`. Keeping them together here means the
 * grammar regex change in one place forces a test update next to it.
 */

import { describe, test, expect } from "bun:test";

import { CortexConfigSchema, PrincipalConfigSchema } from "../cortex-config";
import {
  StackConfigSchema,
  deriveStackId,
  type DerivedStackId,
  type DeriveStackIdInput,
} from "../stack";

// =============================================================================
// Fixture helpers (mirror the patterns in cortex-config.test.ts)
// =============================================================================

const VALID_NKEY = "U" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVZ"; // U + 55

function minOperator() {
  return { id: "andreas" };
}

function minDiscordPresence() {
  return {
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
  };
}

function minAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    presence: { discord: minDiscordPresence() },
    ...overrides,
  };
}

function minConfig(overrides: Record<string, unknown> = {}) {
  return {
    principal: minOperator(),
    agents: [minAgent()],
    claude: {},
    ...overrides,
  };
}

// =============================================================================
// StackConfigSchema — regex coverage
// =============================================================================

describe("StackConfigSchema", () => {
  test("accepts canonical {principal}/{stack} id without nkey_pub", () => {
    const parsed = StackConfigSchema.parse({ id: "andreas/research" });
    expect(parsed.id).toBe("andreas/research");
    expect(parsed.nkey_pub).toBeUndefined();
  });

  test("accepts hyphens and underscores in each segment", () => {
    const parsed = StackConfigSchema.parse({ id: "andreas-dev/research_2026" });
    expect(parsed.id).toBe("andreas-dev/research_2026");
  });

  test("accepts a valid base32 NKey public key on nkey_pub", () => {
    const parsed = StackConfigSchema.parse({
      id: "andreas/research",
      nkey_pub: VALID_NKEY,
    });
    expect(parsed.nkey_pub).toBe(VALID_NKEY);
  });

  test("rejects uppercase principal segment", () => {
    expect(() =>
      StackConfigSchema.parse({ id: "Andreas/research" }),
    ).toThrow(/stack\.id must match/);
  });

  test("rejects uppercase stack segment", () => {
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/Research" }),
    ).toThrow(/stack\.id must match/);
  });

  test("rejects missing slash separator", () => {
    expect(() => StackConfigSchema.parse({ id: "andreas-research" })).toThrow(
      /stack\.id must match/,
    );
  });

  test("rejects multiple slashes (only one separator allowed)", () => {
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research/sub" }),
    ).toThrow(/stack\.id must match/);
  });

  test("rejects empty principal segment", () => {
    expect(() => StackConfigSchema.parse({ id: "/research" })).toThrow(
      /stack\.id must match/,
    );
  });

  test("rejects empty stack segment", () => {
    expect(() => StackConfigSchema.parse({ id: "andreas/" })).toThrow(
      /stack\.id must match/,
    );
  });

  test("rejects segments starting with a digit", () => {
    // NATS subject segments starting with a digit interact poorly with
    // some downstream pattern-matchers; we mirror the agent-id letter-
    // prefix rule for the same reason.
    expect(() => StackConfigSchema.parse({ id: "2andreas/research" })).toThrow(
      /stack\.id must match/,
    );
    expect(() => StackConfigSchema.parse({ id: "andreas/2research" })).toThrow(
      /stack\.id must match/,
    );
  });

  test("rejects whitespace anywhere in id", () => {
    expect(() => StackConfigSchema.parse({ id: "andreas /research" })).toThrow();
    expect(() => StackConfigSchema.parse({ id: "andreas/ research" })).toThrow();
    expect(() => StackConfigSchema.parse({ id: " andreas/research" })).toThrow();
  });

  test("rejects dots (would break NATS subject segmentation)", () => {
    expect(() =>
      StackConfigSchema.parse({ id: "andreas.private/research" }),
    ).toThrow();
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research.v2" }),
    ).toThrow();
  });

  test("rejects NATS wildcards in id", () => {
    expect(() => StackConfigSchema.parse({ id: "andreas/*" })).toThrow();
    expect(() => StackConfigSchema.parse({ id: "andreas/>" })).toThrow();
  });

  test("rejects garbage nkey_pub", () => {
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research", nkey_pub: "garbage" }),
    ).toThrow(/stack\.nkey_pub must be a base32 NKey/);
  });

  test("rejects short nkey_pub (typo / placeholder)", () => {
    // Real NKey user-identifier keys are exactly 56 chars (U + 55 base32).
    // Short placeholders must fail at config time, not silently later.
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research", nkey_pub: "U1" }),
    ).toThrow();
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research", nkey_pub: "UABCDEF1234567890" }),
    ).toThrow();
  });

  test("rejects lowercase chars inside nkey_pub", () => {
    // Base32 alphabet is A-Z 2-7; lowercase and 0/1/8/9 are out of range.
    const bad = "U" + "abcdefghijklmnopqrstuvwxyz".padEnd(55, "A");
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research", nkey_pub: bad }),
    ).toThrow();
  });

  test("rejects nkey_pub with non-U prefix", () => {
    // Stack pub keys are user-identifier keys (`U` prefix). Account / cluster /
    // server prefixes (`A`/`C`/`X`) would silently work today (the NATS lib
    // resolves them), but they signal a misconfiguration — the principal
    // pasted the wrong file's key. Fail-fast at config time.
    const otherPrefix = "A" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVZ";
    expect(otherPrefix).toHaveLength(56);
    expect(() =>
      StackConfigSchema.parse({ id: "andreas/research", nkey_pub: otherPrefix }),
    ).toThrow();
  });
});

// =============================================================================
// CortexConfigSchema — stack block is optional at the top level
// =============================================================================

describe("CortexConfigSchema with stack: block", () => {
  test("absent stack: block parses cleanly (backward compat)", () => {
    const parsed = CortexConfigSchema.parse(minConfig());
    expect(parsed.stack).toBeUndefined();
  });

  test("populated stack: block round-trips through CortexConfigSchema", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({ stack: { id: "andreas/research" } }),
    );
    expect(parsed.stack?.id).toBe("andreas/research");
    expect(parsed.stack?.nkey_pub).toBeUndefined();
  });

  test("populated stack: block with nkey_pub round-trips", () => {
    const parsed = CortexConfigSchema.parse(
      minConfig({ stack: { id: "andreas/research", nkey_pub: VALID_NKEY } }),
    );
    expect(parsed.stack?.nkey_pub).toBe(VALID_NKEY);
  });

  test("invalid stack.id is rejected at top-level CortexConfig parse", () => {
    // The schema embeds StackConfigSchema directly, so the same regex
    // error surfaces at the top level — principals fixing config see the
    // same message regardless of whether they parse the block alone or
    // the full cortex.yaml.
    expect(() =>
      CortexConfigSchema.parse(minConfig({ stack: { id: "Andreas/research" } })),
    ).toThrow(/stack\.id must match/);
  });

  test("invalid stack.nkey_pub is rejected at top-level CortexConfig parse", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({ stack: { id: "andreas/research", nkey_pub: "garbage" } }),
      ),
    ).toThrow(/stack\.nkey_pub must be a base32 NKey/);
  });
});

// =============================================================================
// deriveStackId — the boot-time resolver
// =============================================================================

describe("deriveStackId", () => {
  test("Test 1: explicit stack: block resolves to its literal id", () => {
    const config = CortexConfigSchema.parse(
      minConfig({ stack: { id: "andreas/research" } }),
    );
    const derived: DerivedStackId = deriveStackId(config);
    expect(derived.id).toBe("andreas/research");
    expect(derived.principal).toBe("andreas");
    expect(derived.stack).toBe("research");
  });

  test("Test 2: no stack: block falls back to ${principal.id}/default", () => {
    const config = CortexConfigSchema.parse(minConfig());
    const derived = deriveStackId(config);
    expect(derived.id).toBe("andreas/default");
    expect(derived.principal).toBe("andreas");
    expect(derived.stack).toBe("default");
  });

  test("Test 3: invalid stack.id (uppercase) is rejected at config-load time", () => {
    // The regex enforces lowercase; this never reaches deriveStackId.
    expect(() =>
      CortexConfigSchema.parse(minConfig({ stack: { id: "Andreas/research" } })),
    ).toThrow(/stack\.id must match/);
  });

  test("Test 4: invalid stack.nkey_pub is rejected at config-load time", () => {
    expect(() =>
      CortexConfigSchema.parse(
        minConfig({ stack: { id: "andreas/research", nkey_pub: "garbage" } }),
      ),
    ).toThrow(/stack\.nkey_pub must be a base32 NKey/);
  });

  test("Test 5: missing principal.id default-derives to default/default (total-function contract)", () => {
    // `principal.id` is structurally required by PrincipalConfigSchema, so this is a
    // test-only path: a partial config object passed directly to the helper
    // (e.g. simulating a degraded fixture). The helper must remain total —
    // it never throws — so the missing field falls through to the literal
    // "default" segment on both sides.
    //
    // We cast through `Parameters<typeof deriveStackId>[0]` to bypass the
    // structural-typing requirement that `principal.id` be present; this is
    // exactly what production code can never do via the type system, which
    // is the whole point — the production path is provably-total without
    // this branch firing.
    const degraded: DeriveStackIdInput = { principal: {} };
    const derived = deriveStackId(degraded);
    expect(derived.id).toBe("default/default");
    expect(derived.principal).toBe("default");
    expect(derived.stack).toBe("default");
  });

  test("hyphenated principal id propagates through default derivation", () => {
    const config = CortexConfigSchema.parse(
      minConfig({ principal: { id: "andreas-dev-2026" } }),
    );
    const derived = deriveStackId(config);
    expect(derived.id).toBe("andreas-dev-2026/default");
    expect(derived.principal).toBe("andreas-dev-2026");
    expect(derived.stack).toBe("default");
  });

  test("explicit block wins over principal id (the override path)", () => {
    const config = CortexConfigSchema.parse(
      minConfig({
        principal: { id: "andreas" },
        stack: { id: "jcfischer/sage-host" },
      }),
    );
    const derived = deriveStackId(config);
    expect(derived.id).toBe("jcfischer/sage-host");
    expect(derived.principal).toBe("jcfischer");
    expect(derived.stack).toBe("sage-host");
  });
});

// =============================================================================
// Schema round-trip invariant (cortex#141 — Echo round-1 warning)
// =============================================================================

describe("deriveStackId × StackConfigSchema round-trip invariant", () => {
  // cortex#141 closed the divergence: `PrincipalConfigSchema.id` was tightened to
  // `/^[a-z][a-z0-9-]*$/` (letter-prefix mandatory, hyphen allowed, no
  // underscores), and `StackConfigSchema.id` segments remain
  // `/^[a-z][a-z0-9_-]*$/` (letter-prefix mandatory, underscores additionally
  // allowed in the stack-id half). The two grammars now agree on letter-prefix
  // — every value `PrincipalConfigSchema.id` accepts default-derives to a stack id
  // `StackConfigSchema.id` accepts.
  //
  // This suite is the round-trip invariant test: anything that survives the
  // upstream `PrincipalConfigSchema.id` gate must round-trip cleanly through
  // `deriveStackId → StackConfigSchema.id`. The digit-prefix path that used
  // to surface the divergence is now blocked at the upstream gate
  // (`PrincipalConfigSchema.id.parse("2andreas")` throws), so the latent runtime
  // failure A.5.5 was at risk of surfacing is structurally impossible.

  const stackIdSchema = StackConfigSchema.shape.id;

  test("derived id round-trips for letter-prefixed alphanumeric principal", () => {
    const derived = deriveStackId({ principal: { id: "andreas" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("derived id round-trips for hyphenated principal", () => {
    const derived = deriveStackId({ principal: { id: "andreas-dev-2026" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("derived id round-trips for all-alpha principal", () => {
    const derived = deriveStackId({ principal: { id: "metafactory" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("derived id round-trips for principal with internal digits", () => {
    const derived = deriveStackId({ principal: { id: "team-42-research" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("explicit stack id round-trips (tautological, but pins the contract)", () => {
    const derived = deriveStackId({
      principal: { id: "andreas" },
      stack: { id: "andreas/research_2026" },
    });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("cortex#141 closed: digit-prefix principal id is rejected at PrincipalConfigSchema gate", () => {
    // Pre-cortex#141: `PrincipalConfigSchema.id` accepted `"2andreas"` (regex
    // `/^[a-z0-9-]+$/`), so `deriveStackId` produced `"2andreas/default"` —
    // a string `StackConfigSchema.id` rejected. The divergence was a latent
    // self-inconsistency that A.5.5's namespace cutover would surface as a
    // runtime error.
    //
    // Post-cortex#141: `PrincipalConfigSchema.id` regex is `/^[a-z][a-z0-9-]*$/`
    // (letter-prefix mandatory). Digit-prefix principal ids are rejected at
    // the upstream Zod gate, so `deriveStackId` never receives an invalid
    // input from a parsed `CortexConfig`. The latent divergence is
    // structurally closed — this test pins the invariant.
    expect(() => PrincipalConfigSchema.parse({ id: "2andreas" })).toThrow(
      /starting with a letter/,
    );
    // `deriveStackId` itself is a total function and still works on the
    // narrowed `DeriveStackIdInput` shape — but no production code path can
    // pass a digit-prefix `principal.id` through to it, because every config
    // is parsed through `PrincipalConfigSchema` first.
  });
});
