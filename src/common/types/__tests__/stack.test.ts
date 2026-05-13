/**
 * IAW Phase A.5 — `StackConfigSchema` + `deriveStackId` tests (cortex#113).
 *
 * Two surfaces under test:
 *   1. `StackConfigSchema` — accepts well-formed `{operator}/{stack}` ids and
 *      base32 NKey public keys; rejects uppercase, missing slash, garbage
 *      NKeys, and other shape violations the regexes guard against.
 *   2. `deriveStackId` — explicit `stack:` block wins; otherwise default-
 *      derives `${operator.id}/default`. The total-function contract holds
 *      even when `operator.id` is missing (test-only edge case): falls back
 *      to `default/default` rather than throwing.
 *
 * The schema-side tests live next to the rest of the cortex-config schema
 * tests (`./cortex-config.test.ts`) by file-naming convention, but the
 * `deriveStackId` logic warrants its own test file because the helper has
 * its own module — `../stack.ts`. Keeping them together here means the
 * grammar regex change in one place forces a test update next to it.
 */

import { describe, test, expect } from "bun:test";

import { CortexConfigSchema } from "../cortex-config";
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
    operator: minOperator(),
    agents: [minAgent()],
    claude: {},
    ...overrides,
  };
}

// =============================================================================
// StackConfigSchema — regex coverage
// =============================================================================

describe("StackConfigSchema", () => {
  test("accepts canonical {operator}/{stack} id without nkey_pub", () => {
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

  test("rejects uppercase operator segment", () => {
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

  test("rejects empty operator segment", () => {
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
    // resolves them), but they signal a misconfiguration — the operator
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
    // error surfaces at the top level — operators fixing config see the
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
    expect(derived.operator).toBe("andreas");
    expect(derived.stack).toBe("research");
  });

  test("Test 2: no stack: block falls back to ${operator.id}/default", () => {
    const config = CortexConfigSchema.parse(minConfig());
    const derived = deriveStackId(config);
    expect(derived.id).toBe("andreas/default");
    expect(derived.operator).toBe("andreas");
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

  test("Test 5: missing operator.id default-derives to default/default (total-function contract)", () => {
    // `operator.id` is structurally required by OperatorSchema, so this is a
    // test-only path: a partial config object passed directly to the helper
    // (e.g. simulating a degraded fixture). The helper must remain total —
    // it never throws — so the missing field falls through to the literal
    // "default" segment on both sides.
    //
    // We cast through `Parameters<typeof deriveStackId>[0]` to bypass the
    // structural-typing requirement that `operator.id` be present; this is
    // exactly what production code can never do via the type system, which
    // is the whole point — the production path is provably-total without
    // this branch firing.
    const degraded: DeriveStackIdInput = { operator: {} };
    const derived = deriveStackId(degraded);
    expect(derived.id).toBe("default/default");
    expect(derived.operator).toBe("default");
    expect(derived.stack).toBe("default");
  });

  test("hyphenated operator id propagates through default derivation", () => {
    const config = CortexConfigSchema.parse(
      minConfig({ operator: { id: "andreas-dev-2026" } }),
    );
    const derived = deriveStackId(config);
    expect(derived.id).toBe("andreas-dev-2026/default");
    expect(derived.operator).toBe("andreas-dev-2026");
    expect(derived.stack).toBe("default");
  });

  test("explicit block wins over operator id (the override path)", () => {
    const config = CortexConfigSchema.parse(
      minConfig({
        operator: { id: "andreas" },
        stack: { id: "jcfischer/sage-host" },
      }),
    );
    const derived = deriveStackId(config);
    expect(derived.id).toBe("jcfischer/sage-host");
    expect(derived.operator).toBe("jcfischer");
    expect(derived.stack).toBe("sage-host");
  });
});

// =============================================================================
// Schema round-trip invariant (cortex#141 — Echo round-1 warning)
// =============================================================================

describe("deriveStackId × StackConfigSchema round-trip invariant", () => {
  // `OperatorSchema.id` is `/^[a-z0-9-]+$/` (digit-prefix legal, no underscores).
  // `StackConfigSchema.id` segments are `/^[a-z][a-z0-9_-]*$/` (letter-prefix
  // mandatory, underscores legal). These grammars overlap on the realistic
  // common case (letter-prefixed alphanumeric + hyphen) but diverge at the
  // edges. The grammar unification decision is tracked in cortex#141; this
  // suite pins the current behaviour so the A.5.5 namespace cutover does not
  // surface the divergence as a runtime error without warning.

  const stackIdSchema = StackConfigSchema.shape.id;

  test("derived id round-trips for letter-prefixed alphanumeric operator", () => {
    const derived = deriveStackId({ operator: { id: "andreas" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("derived id round-trips for hyphenated operator", () => {
    const derived = deriveStackId({ operator: { id: "andreas-dev-2026" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("derived id round-trips for all-alpha operator", () => {
    const derived = deriveStackId({ operator: { id: "metafactory" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("derived id round-trips for operator with internal digits", () => {
    const derived = deriveStackId({ operator: { id: "team-42-research" } });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("explicit stack id round-trips (tautological, but pins the contract)", () => {
    const derived = deriveStackId({
      operator: { id: "andreas" },
      stack: { id: "andreas/research_2026" },
    });
    expect(() => stackIdSchema.parse(derived.id)).not.toThrow();
  });

  test("KNOWN GAP (cortex#141): digit-prefix operator id default-derives to a string StackConfigSchema rejects", () => {
    // `2andreas` is legal under `OperatorSchema.id` (`/^[a-z0-9-]+$/`) today.
    // `StackConfigSchema.id` requires letter-prefix on each segment, so the
    // default-derived `2andreas/default` fails the stack schema. This test
    // documents the divergence so an unintended schema tightening (or an
    // A.5.5 self-consistency check that round-trips through the stack
    // schema) doesn't silently break this path; resolution is tracked in
    // cortex#141 (unify the two grammars before A.5.5 lands).
    const derived = deriveStackId({ operator: { id: "2andreas" } });
    expect(derived.id).toBe("2andreas/default");
    expect(() => stackIdSchema.parse(derived.id)).toThrow();
  });
});
