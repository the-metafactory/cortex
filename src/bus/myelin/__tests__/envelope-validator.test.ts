/**
 * G-1100.B: Envelope validator tests.
 *
 * Uses the real example envelopes from upstream myelin as fixtures —
 * valid-envelope.json and invalid-missing-sovereignty.json — copied
 * into __fixtures__/ at vendor time. If the schema is upgraded, these
 * fixtures should be re-copied alongside the schema (see
 * SCHEMA_SOURCE_COMMIT in envelope-validator.ts).
 */

import { describe, expect, test } from "bun:test";
import { createUser } from "@nats-io/nkeys";
import { signEnvelope } from "@the-metafactory/myelin/identity";
import {
  deriveNatsSubject,
  getActorPrincipal,
  getLastStampPrincipal,
  getSignedByChain,
  SCHEMA_SOURCE_COMMIT,
  tryParseEnvelope,
  validateEnvelope,
  validateSubjectEnvelopeAlignment,
  type Envelope,
} from "../envelope-validator";
import { verifySignedByChain } from "../../verify-signed-by-chain";
import { AgentRegistry } from "../../../common/agents/registry";
import { TrustResolver } from "../../../common/agents/trust-resolver";
import type { Agent } from "../../../common/types/cortex-config";
import validEnvelope from "../vendor/__fixtures__/valid-envelope.json" with { type: "json" };
import invalidMissingSovereignty from "../vendor/__fixtures__/invalid-missing-sovereignty.json" with { type: "json" };
// The vendored schema this module validates against — byte-compared below
// against the installed package schema (cortex#366 stale-install guard).
import vendoredSchema from "../vendor/envelope.schema.json" with { type: "json" };

describe("envelope-validator", () => {
  test("schema source commit is recorded for upgrade audit", () => {
    expect(SCHEMA_SOURCE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  test("validates the upstream valid example", () => {
    const result = validateEnvelope(validEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.envelope.sovereignty.classification).toBe("local");
      expect(result.envelope.sovereignty.model_class).toBe("local-only");
    }
  });

  test("rejects the upstream invalid example (missing sovereignty)", () => {
    const result = validateEnvelope(invalidMissingSovereignty);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The Ajv error path or schemaPath should reference sovereignty.
      const surfacesSovereignty = result.errors.some(
        (e) =>
          e.instancePath.includes("sovereignty") ||
          e.schemaPath.includes("sovereignty") ||
          e.params?.missingProperty === "sovereignty",
      );
      expect(surfacesSovereignty).toBe(true);
    }
  });

  test("rejects an envelope with bad sovereignty.classification", () => {
    const bad = {
      ...(validEnvelope as object),
      sovereignty: {
        ...(validEnvelope as { sovereignty: object }).sovereignty,
        classification: "secret", // not in {local, federated, public}
      },
    };
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
  });

  test("rejects an envelope with non-uuid id", () => {
    const bad = { ...(validEnvelope as object), id: "not-a-uuid" };
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
  });

  test("rejects an envelope missing required type field", () => {
    const bad = { ...(validEnvelope as { type?: string }) };
    delete bad.type;
    const result = validateEnvelope(bad);
    expect(result.ok).toBe(false);
  });

  test("accepts an envelope without optional correlation_id and extensions", () => {
    const minimal = { ...(validEnvelope as object) };
    delete (minimal as { correlation_id?: string }).correlation_id;
    delete (minimal as { extensions?: object }).extensions;
    const result = validateEnvelope(minimal);
    expect(result.ok).toBe(true);
  });

  test("tryParseEnvelope returns the envelope on valid input", () => {
    const env = tryParseEnvelope(validEnvelope);
    expect(env).not.toBeNull();
    expect(env?.type).toBe("ops.deploy.completed");
  });

  test("tryParseEnvelope returns null on invalid input", () => {
    const env = tryParseEnvelope(invalidMissingSovereignty);
    expect(env).toBeNull();
  });

  test("tryParseEnvelope returns null on garbage", () => {
    expect(tryParseEnvelope(null)).toBeNull();
    expect(tryParseEnvelope("a string")).toBeNull();
    expect(tryParseEnvelope(42)).toBeNull();
    expect(tryParseEnvelope({})).toBeNull();
  });

  // signed_by coverage — added per Echo cycle-1 review of #71. The schema
  // defines a oneOf over ed25519 and hub-stamp; without these tests the
  // identity-attestation path is silent. Base64 strings are 88-char ed25519
  // sig length per the schema's minLength constraint.
  const ED25519_SIG = "A".repeat(88);

  test("accepts an envelope with valid ed25519 signed_by (legacy single-stamp shim)", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "ed25519",
        // myelin#182 (R2 breaking cut) — stamps carry `identity`, not the
        // deprecated `principal` key. Pre-#182 the dual reader accepted
        // either; this test was updated at cortex#453 to assert the
        // canonical-only schema.
        identity: "did:mf:luna",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Single-stamp wire shape — surfaced as the object form. `getSignedByChain`
      // normalises this to an array in the next describe block.
      const stamp = result.envelope.signed_by;
      expect(stamp && !Array.isArray(stamp) ? stamp.method : null).toBe(
        "ed25519",
      );
    }
  });

  test("accepts an envelope with valid hub-stamp signed_by", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "hub-stamp",
        identity: "did:mf:luna",
        stamped_by: "did:mf:hub-eu-1",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const stamp = result.envelope.signed_by;
      expect(
        stamp && !Array.isArray(stamp) && stamp.method === "hub-stamp"
          ? stamp.stamped_by
          : null,
      ).toBe("did:mf:hub-eu-1");
    }
  });

  test("rejects an ed25519 signed_by missing the signature field", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "ed25519",
        identity: "did:mf:luna",
        // signature: missing
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a hub-stamp signed_by missing stamped_by", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "hub-stamp",
        identity: "did:mf:luna",
        // stamped_by: missing — required for hub-stamp shape
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a signed_by with non-DID identity", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: {
        method: "ed25519",
        identity: "not-a-did",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  // IAW Phase A.2 — chain-of-stamps (myelin#31). Cortex now surfaces the
  // array form of `signed_by` so Phase B can wire trust decisions against
  // real chain shapes; this slice asserts the schema accepts the array
  // form and the cortex helpers normalise both shapes uniformly.

  test("accepts an envelope with a chain-of-stamps (array form, myelin#31)", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:luna",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
          role: "origin",
        },
        {
          method: "hub-stamp",
          identity: "did:mf:luna",
          stamped_by: "did:mf:hub-eu-1",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:01Z",
          role: "transit",
        },
      ],
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const stamp = result.envelope.signed_by;
      expect(Array.isArray(stamp)).toBe(true);
      if (Array.isArray(stamp)) {
        expect(stamp.length).toBe(2);
        expect(stamp[0]?.method).toBe("ed25519");
        expect(stamp[0]?.role).toBe("origin");
        expect(stamp[1]?.method).toBe("hub-stamp");
      }
    }
  });

  test("rejects a chain-of-stamps with an invalid stamp shape", () => {
    const env = {
      ...(validEnvelope as object),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:luna",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
        },
        {
          method: "ed25519",
          identity: "did:mf:luna",
          // signature: missing — second stamp is malformed
          at: "2026-05-08T09:00:01Z",
        },
      ],
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects an empty chain-of-stamps", () => {
    const env = { ...(validEnvelope as object), signed_by: [] };
    const result = validateEnvelope(env);
    // The schema requires minItems: 1 when the array shape is used.
    expect(result.ok).toBe(false);
  });

  test("accepts an unknown stamp role at the schema layer (forward-compat)", () => {
    // The schema's `stampRole` enum is closed today, so a literal unknown
    // role would be rejected. Older stamps with no `role` field at all
    // remain accepted — verified by the legacy-shim test above. This test
    // exercises the canonical, well-known roles to lock the enum surface.
    const env = {
      ...(validEnvelope as object),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:luna",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
          role: "notary",
        },
      ],
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
  });
});

describe("envelope-validator — F-021 task envelope fields (IAW Phase A.2)", () => {
  // F-021 adds five optional task-routing fields. They are SURFACED in cortex
  // (visible on the typed Envelope) but not yet acted on for routing or
  // trust — that's IAW Phase B / cortex#102 territory.

  test("accepts an envelope with all F-021 task fields populated (direct)", () => {
    const env = {
      ...(validEnvelope as object),
      requirements: ["code-review", "typescript"],
      sovereignty_required: "strict",
      deadline: "2026-06-01T00:00:00Z",
      distribution_mode: "direct",
      target_assistant: "did:mf:echo",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.requirements).toEqual(["code-review", "typescript"]);
      expect(result.envelope.sovereignty_required).toBe("strict");
      expect(result.envelope.distribution_mode).toBe("direct");
      expect(result.envelope.target_assistant).toBe("did:mf:echo");
      expect(result.envelope.deadline).toBe("2026-06-01T00:00:00Z");
    }
  });

  test("accepts an offer envelope with no target_assistant (canonical R11)", () => {
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "offer",
      sovereignty_required: "open",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
  });

  test("rejects a broadcast envelope (deprecated alias removed in myelin v0.6.0)", () => {
    // Vocabulary migration 2026-05 — `broadcast` was the deprecated alias
    // of `offer`. myelin v0.6.0 removed `broadcast` from the wire entirely,
    // so the schema no longer accepts it on read.
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "broadcast",
      sovereignty_required: "open",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a direct envelope missing target_assistant", () => {
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "direct",
      // target_assistant: missing — schema cross-field rule rejects
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a delegate envelope missing target_assistant", () => {
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "delegate",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a direct envelope that carries the dropped target_principal key (R13 breaking cut)", () => {
    // Vocabulary migration 2026-05 R13 / myelin#184 — `target_principal`
    // was removed from the wire. The schema's `additionalProperties: false`
    // now rejects any envelope that still carries it, even when a valid
    // `target_assistant` is also present.
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "direct",
      target_assistant: "did:mf:echo",
      target_principal: "did:mf:echo",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects an unknown sovereignty_required mode", () => {
    const env = {
      ...(validEnvelope as object),
      sovereignty_required: "absolute",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects an unknown distribution_mode", () => {
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "multicast",
      target_assistant: "did:mf:echo",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("rejects a target_assistant that is not a DID", () => {
    const env = {
      ...(validEnvelope as object),
      distribution_mode: "direct",
      target_assistant: "echo@example.com",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });

  test("accepts an envelope with the F-021 bidding sovereignty mode", () => {
    // R11 (vocabulary migration 2026-05) — bidding sovereignty uses the
    // canonical `offer` distribution_mode; the deprecated `broadcast`
    // alias is exercised in the separate back-compat test above.
    const env = {
      ...(validEnvelope as object),
      sovereignty_required: "bidding",
      distribution_mode: "offer",
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(true);
  });

  test("envelope without F-021 fields stays valid (backward compatible)", () => {
    // The pre-F-021 fixture has no task fields — the new schema must accept
    // it unchanged. This locks the back-compat guarantee for legacy emitters
    // until A.3 parameterises emit sites.
    const result = validateEnvelope(validEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.requirements).toBeUndefined();
      expect(result.envelope.distribution_mode).toBeUndefined();
      expect(result.envelope.target_assistant).toBeUndefined();
    }
  });

  test("rejects a requirements tag that violates the DID-style pattern", () => {
    const env = {
      ...(validEnvelope as object),
      requirements: ["TypeScript"], // capital letter — pattern is lowercase only
    };
    const result = validateEnvelope(env);
    expect(result.ok).toBe(false);
  });
});

describe("envelope-validator — chain helpers (IAW Phase A.2)", () => {
  const ED25519_SIG = "A".repeat(88);

  test("getSignedByChain returns [] for an unsigned envelope", () => {
    const env = tryParseEnvelope(validEnvelope);
    expect(env).not.toBeNull();
    expect(getSignedByChain(env!)).toEqual([]);
  });

  test("getSignedByChain normalises a single-stamp object to a 1-element array", () => {
    const env: Envelope = {
      ...(validEnvelope as unknown as Envelope),
      signed_by: {
        method: "ed25519",
        identity: "did:mf:luna",
        signature: ED25519_SIG,
        at: "2026-05-08T09:00:00Z",
      },
    };
    const chain = getSignedByChain(env);
    expect(chain.length).toBe(1);
    expect(chain[0]?.method).toBe("ed25519");
  });

  test("getSignedByChain returns the array form as-is", () => {
    const env: Envelope = {
      ...(validEnvelope as unknown as Envelope),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:luna",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
          role: "origin",
        },
        {
          method: "hub-stamp",
          identity: "did:mf:luna",
          stamped_by: "did:mf:hub-eu-1",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:01Z",
          role: "transit",
        },
      ],
    };
    const chain = getSignedByChain(env);
    expect(chain.length).toBe(2);
    expect(chain[1]?.method).toBe("hub-stamp");
  });

  test("getLastStampPrincipal returns the principal of the last stamp", () => {
    const env: Envelope = {
      ...(validEnvelope as unknown as Envelope),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:luna",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
        },
        {
          method: "hub-stamp",
          identity: "did:mf:luna",
          stamped_by: "did:mf:hub-eu-1",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:01Z",
        },
      ],
    };
    expect(getLastStampPrincipal(env)).toBe("did:mf:luna");
  });

  test("getLastStampPrincipal returns undefined for an unsigned envelope", () => {
    const env = tryParseEnvelope(validEnvelope);
    expect(env).not.toBeNull();
    expect(getLastStampPrincipal(env!)).toBeUndefined();
  });

  // cortex#346 / myelin#161 — vendored getActorPrincipal mirror
  test("getActorPrincipal prefers originator over signed_by chain", () => {
    const env: Envelope = {
      ...(validEnvelope as unknown as Envelope),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:cortex",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
        },
      ],
      // R2 originator dual-read still active — `principal` key remains
      // accepted alongside `identity` until the originator lockstep PR.
      originator: {
        principal: "did:mf:alice",
        attribution: "adapter-resolved",
      },
    };
    expect(getActorPrincipal(env)).toBe("did:mf:alice");
  });

  test("getActorPrincipal falls back to signed_by[0].identity when originator absent", () => {
    const env: Envelope = {
      ...(validEnvelope as unknown as Envelope),
      signed_by: [
        {
          method: "ed25519",
          identity: "did:mf:cortex",
          signature: ED25519_SIG,
          at: "2026-05-08T09:00:00Z",
        },
      ],
    };
    expect(getActorPrincipal(env)).toBe("did:mf:cortex");
  });

  test("getActorPrincipal returns undefined for an unsigned envelope with no originator", () => {
    const env = tryParseEnvelope(validEnvelope);
    expect(env).not.toBeNull();
    expect(getActorPrincipal(env!)).toBeUndefined();
  });

  // cortex#346 review-loop (Echo r1 architecture suggestion) — drift guard.
  //
  // The vendored `getActorPrincipal` mirrors `@the-metafactory/myelin`'s
  // helper at `node_modules/@the-metafactory/myelin/src/envelope.ts`.
  // `SCHEMA_SOURCE_COMMIT` pins the schema-string copy; the docstring
  // `@see` breadcrumb on the local `getActorPrincipal` points future
  // maintainers at the upstream definition with "keep this in sync".
  //
  // An upstream-helper parity test (importing myelin's getActorPrincipal
  // and asserting identical output across the 3 precedence cases) was
  // attempted but pulls myelin's `src/envelope.ts` into cortex's tsc
  // surface, surfacing a pre-existing upstream strict-null gap
  // (`envelope.ts:527` — `string | undefined` vs `string` on
  // `envelope.source.split('.')[0]`) that's unrelated to this PR.
  // Echo classified the upstream-parity test as a non-blocking
  // suggestion and accepted the `@see` breadcrumb alone as sufficient
  // for cortex#346. The full contract test belongs in a follow-up that
  // can also patch the upstream gap (filed as a separate concern).
  //
  // The three local-precedence tests above plus the SCHEMA_SOURCE_COMMIT
  // drift guard plus the `@see` breadcrumb together cover the maintainer-
  // ergonomic side of Echo's suggestion without dragging upstream noise
  // into this PR.

  test("schema source commit points at the v0.7.0 tag's commit (breadcrumb lock)", () => {
    // Lock the provenance breadcrumb so future bumps surface in a code review.
    // History: 3ec0ace → e37b347 (vocabulary migration 2026-05 transition) →
    // 4c54b8e → f5ec865 (cortex#436/#81/PR-R10, `target_principal` breaking cut)
    // → a69ecd7 (v0.6.0). Now the commit that the **v0.7.0** tag dereferences to
    // (cortex#2034 de-dup prereq — package.json pins the `v0.7.0` tag per
    // design-rfc-alignment.md D4, carrying the ./wire library). The vendored
    // schema is byte-unchanged across this bump (loose-flat DID pattern; the
    // ./wire class-explicit schema is a SEPARATE flag-day, deferred). This is a
    // cheap constant lock; the real freshness guard is the byte-compare below.
    expect(SCHEMA_SOURCE_COMMIT).toBe(
      "c534a0b9ea66066d5fe2731c2dc62a27561a9e56",
    );
  });

  test("vendored schema is byte-identical to the installed package schema (cortex#366 stale-install guard)", async () => {
    // The FRESHNESS/DRIFT contract, pin-format-agnostic (cortex#2034 prereq).
    // Replaces the old "SCHEMA_SOURCE_COMMIT === the 40-char SHA in the
    // package.json pin" assertion, which could not survive the switch to a
    // legible `v0.7.0` **tag** pin (D4). This is the STRONGER guard: it does not
    // trust a hand-copied SHA string — it byte-compares the vendored copy this
    // module validates against with the schema that ships in the INSTALLED
    // `@the-metafactory/myelin` package (the same tree the runtime
    // `deriveSubject` / signing grammar is pulled from). If a future dep bump
    // (or a stale `node_modules`, the exact cortex#366 P1 footgun) drifts the
    // installed schema away from the vendored copy, this fails at test time —
    // cortex can never silently validate new-grammar envelopes against an old
    // vendored schema, or vice versa.
    const installed = (await import(
      "@the-metafactory/myelin/schemas/envelope.schema.json",
      { with: { type: "json" } }
    )) as { default: typeof vendoredSchema };
    expect(vendoredSchema).toEqual(installed.default);
  });
});

// ---------------------------------------------------------------------------
// cortex#366 — stale-myelin-install regression guard.
//
// WHY THIS GUARD EXISTS — DO NOT DELETE AS REDUNDANT.
//
// PR #358 (cortex#346, v2.0.6) wired myelin#161's `Envelope.originator`
// policy-attribution field through cortex on the security contract that
// `originator` is in myelin's `SIGNABLE_FIELDS` — so tampering it post-sign
// invalidates the stack signature and the receiver rejects with a crypto
// failure.
//
// That contract silently did NOT hold on `main`: a worktree `bun install`
// during an unrelated rebase resolved the github-commit-pinned myelin dep to
// a cached OLDER tree whose `SIGNABLE_FIELDS` stopped at `target_principal`
// and did not include `originator`. `package.json` and `bun.lock` both pinned
// the correct SHA (3ec0ace) the whole time — only the installed
// `node_modules/@the-metafactory/myelin` was stale. The result: `signEnvelope`
// signed over the stale field set, `originator` never entered the signed
// bytes, and tampering it post-sign did not break the signature. Tamper to a
// KNOWN principal would have impersonated that principal. (cortex#366, P1.)
//
// The `SCHEMA_SOURCE_COMMIT` guards above pin the *schema string* copy and
// the package.json *pin*. Neither catches a stale *installed signing path* —
// they would both still pass while `node_modules` carried old bytes. THIS
// test is the only one that exercises the actual installed `signEnvelope` +
// crypto-verify round-trip against the `originator` field, so a stale install
// fails the test suite here instead of being found by a security researcher
// in prod.
//
// NOTE: cortex CI does not yet run `bun test` (only lint + label-check), so
// this guard does not run in CI *yet* — wiring the test suite into CI is
// tracked separately in cortex#376. Until then, the guard protects any
// developer running the suite locally and is TDD-proven (it fails against a
// stale install and passes against a correct one).
// ---------------------------------------------------------------------------

describe("envelope-validator — originator signature coverage (cortex#366)", () => {
  // Minimal Discord presence block so the Agent fixture type-checks; the
  // crypto round-trip below does not touch presence.
  function discordPresence() {
    return {
      enabled: true,
      token: "discord-bot-token",
      guildId: "1111111111111111111",
      agentChannelId: "2222222222222222222",
      logChannelId: "3333333333333333333",
      contextDepth: 10,
      enableAgentLog: false,
      roles: [],
      defaultRole: "allow-all",
      dm: {
        operatorRole: {
          features: ["chat", "async", "team"] as const,
          disallowedTools: [],
          bashGuard: true,
        },
        defaultRole: "denied" as const,
        userRoles: [],
      },
    };
  }

  function agentFixture(overrides: Partial<Agent> = {}): Agent {
    return {
      id: "luna",
      displayName: "Luna",
      persona: "./personas/luna.md",
      roles: [],
      trust: [],
      presence: { discord: discordPresence() },
      ...overrides,
    } as Agent;
  }

  // Fresh ed25519 NATS user keypair — `nkeyPub` (U-prefixed base32) for the
  // agent registry, `privateKeyBase64` (raw 32-byte seed) for `signEnvelope`.
  function generateEd25519KeyPair(): {
    nkeyPub: string;
    privateKeyBase64: string;
  } {
    const kp = createUser();
    const nkeyPub = kp.getPublicKey();
    // `KP`'s concrete class exposes `getRawSeed()` returning the raw
    // 32-byte ed25519 seed — the shape `signEnvelope` wants. The public
    // `KeyPair` interface hides it (it only surfaces the wrapped 58-char
    // NKey-encoded seed via `getSeed()`), so the double-cast reaches the
    // concrete method. Test-only cast, mirrors verify-signed-by-chain.test.ts.
    const rawSeed = (
      kp as unknown as { getRawSeed(): Uint8Array }
    ).getRawSeed();
    const privateKeyBase64 = Buffer.from(rawSeed).toString("base64");
    return { nkeyPub, privateKeyBase64 };
  }

  test("originator is covered by the signature — stale myelin install regression guard (cortex#366)", async () => {
    // Receiver "cortex" trusts sender "echo".
    const { nkeyPub: echoNKey, privateKeyBase64: echoSeed } =
      generateEd25519KeyPair();
    const cortex = agentFixture({ id: "cortex", trust: ["echo"] });
    const echo = agentFixture({
      id: "echo",
      displayName: "Echo",
      nkey_pub: echoNKey,
    });
    const resolver = new TrustResolver(
      AgentRegistry.fromAgents([cortex, echo]),
    );

    // Build an envelope that carries an `originator` block, then sign it.
    // If `originator` is in myelin's SIGNABLE_FIELDS (correct install), the
    // signer commits to it; the canonical bytes include `originator`.
    const base = {
      ...(validEnvelope as object),
      originator: {
        principal: "did:mf:echo",
        attribution: "adapter-resolved",
      },
    } as unknown as Parameters<typeof signEnvelope>[0];
    const signed = await signEnvelope(base, echoSeed, "did:mf:echo");

    // Sanity: the happy path verifies. If this fails the fixture is broken,
    // not the security property.
    const ok = await verifySignedByChain(signed, {
      resolver,
      receivingAgentId: "cortex",
      cryptoVerify: true,
      principalId: "test-principal",
    });
    expect(ok.valid).toBe(true);

    // Tamper: swap `originator.principal` to `did:mf:cortex` post-sign — a
    // KNOWN, registered principal (cortex#366's acceptance criterion asks
    // for a known principal specifically, because that is the precise
    // impersonation loophole: an unknown principal would also be caught by
    // the downstream policy layer, but a known one would not — only the
    // signature covering `originator` stops it).
    // With a CORRECT myelin install, `originator` is a signable field, so the
    // canonical bytes no longer match the signature → crypto verify rejects.
    // With a STALE myelin install, `originator` is outside SIGNABLE_FIELDS,
    // the tampered bytes still match the signature, and this assertion FAILS
    // (the verify returns valid:true) — which is exactly the cortex#366 bug.
    const tampered: Envelope = {
      ...(signed as Envelope),
      originator: {
        principal: "did:mf:cortex",
        attribution: "adapter-resolved",
      },
    };

    const result = await verifySignedByChain(tampered, {
      resolver,
      receivingAgentId: "cortex",
      cryptoVerify: true,
      principalId: "test-principal",
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason.kind).toBe("crypto_verify_failed");
    }
  });
});

// ---------------------------------------------------------------------------
// IAW Phase A.3 — subject derivation + envelope alignment.
// ---------------------------------------------------------------------------

describe("deriveNatsSubject (IAW A.3)", () => {
  function envWithClassification(
    classification: Envelope["sovereignty"]["classification"],
    source = "metafactory.cortex.local",
    type = "system.adapter.degraded",
    extensions?: Record<string, unknown>,
  ): Envelope {
    return {
      ...(validEnvelope as unknown as Envelope),
      source,
      type,
      sovereignty: {
        ...(validEnvelope as unknown as Envelope).sovereignty,
        classification,
      },
      ...(extensions !== undefined ? { extensions } : {}),
    };
  }

  test("local classification → local.{principal}.{type}", () => {
    const env = envWithClassification("local");
    expect(deriveNatsSubject(env)).toBe(
      "local.metafactory.system.adapter.degraded",
    );
  });

  // ADR 0001 (supersedes cortex#661) — federated subjects carry the SAME
  // identity segments as local.*: segment[1] is the `{principal}` from
  // `envelope.source`, NOT a target network_id. The network is never on the
  // wire; it is resolved from the target principal at the routing layer
  // (`selectLink` → `peers[]`). `CONTEXT.md`: "A network is NOT a subject
  // segment … never a network name on the wire."
  test("federated classification → federated.{principal}.{type} (from envelope.source, identical to local)", () => {
    const env = envWithClassification(
      "federated",
      "metafactory.cortex.local",
      "system.adapter.degraded",
    );
    expect(deriveNatsSubject(env)).toBe(
      "federated.metafactory.system.adapter.degraded",
    );
  });

  // ADR 0001 — a federated envelope no longer needs extensions.network_id to
  // derive a subject: the network is not on the wire. An absent network hint is
  // NOT an emit error (cortex#661's fail-loud throw is retired).
  test("federated classification without extensions.network_id → derives a valid subject (no throw)", () => {
    const env = envWithClassification("federated");
    expect(deriveNatsSubject(env)).toBe(
      "federated.metafactory.system.adapter.degraded",
    );
  });

  // ADR 0001 — extensions.network_id MAY travel as a routing HINT, but it is
  // NOT a subject segment: a stale/mismatched hint never leaks into the subject,
  // which is derived purely from `envelope.source`'s principal segment.
  test("federated extensions.network_id is ignored for subject derivation (routing hint only)", () => {
    const env = envWithClassification(
      "federated",
      "metafactory.cortex.local",
      "system.adapter.degraded",
      { network_id: "research-collab" },
    );
    expect(deriveNatsSubject(env)).toBe(
      "federated.metafactory.system.adapter.degraded",
    );
  });

  test("public classification → public.{type} (no org segment)", () => {
    const env = envWithClassification("public");
    expect(deriveNatsSubject(env)).toBe("public.system.adapter.degraded");
  });

  test("derives {principal} from envelope.source's first segment", () => {
    // A different principal (`acme.*`) routes onto its own subject namespace
    // without any runtime-side configuration.
    const env = envWithClassification("local", "acme.cortex.prod-01");
    expect(deriveNatsSubject(env)).toBe(
      "local.acme.system.adapter.degraded",
    );
  });

  // IAW Phase A.5 — stack-aware subject emission (myelin#113 grammar).
  test("local + stack → local.{principal}.{stack}.{type}", () => {
    const env = envWithClassification("local");
    expect(deriveNatsSubject(env, "research")).toBe(
      "local.metafactory.research.system.adapter.degraded",
    );
  });

  // ADR 0001 — federated stack-aware form is byte-identical to local's:
  // `federated.{principal}.{stack}.{type}`, principal from envelope.source.
  test("federated + stack → federated.{principal}.{stack}.{type}", () => {
    const env = envWithClassification(
      "federated",
      "metafactory.cortex.local",
      "system.adapter.degraded",
    );
    expect(deriveNatsSubject(env, "security")).toBe(
      "federated.metafactory.security.system.adapter.degraded",
    );
  });

  test("public + stack → stack is dropped (public is global)", () => {
    // `public.` subjects never carry an org or stack segment, regardless of
    // what the caller supplies — matches myelin#113 grammar.
    const env = envWithClassification("public");
    expect(deriveNatsSubject(env, "devops")).toBe(
      "public.system.adapter.degraded",
    );
  });

  test("invalid stack segment is rejected by myelin grammar", () => {
    // STACK_SEGMENT_REGEX = /^[a-z][a-z0-9-]{0,62}$/ — uppercase rejected.
    const env = envWithClassification("local");
    expect(() => deriveNatsSubject(env, "BadStack")).toThrow(/stack segment/i);
  });
});

describe("validateSubjectEnvelopeAlignment (IAW A.3)", () => {
  function envWithClassification(
    classification: Envelope["sovereignty"]["classification"],
  ): Envelope {
    return {
      ...(validEnvelope as unknown as Envelope),
      sovereignty: {
        ...(validEnvelope as unknown as Envelope).sovereignty,
        classification,
      },
    };
  }

  test("aligned local subject", () => {
    const env = envWithClassification("local");
    const result = validateSubjectEnvelopeAlignment(
      "local.metafactory.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(true);
    expect(result.expected).toBe("local");
    expect(result.actual).toBe("local");
  });

  test("aligned federated subject", () => {
    const env = envWithClassification("federated");
    const result = validateSubjectEnvelopeAlignment(
      "federated.metafactory.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(true);
  });

  test("aligned public subject (no org segment)", () => {
    const env = envWithClassification("public");
    const result = validateSubjectEnvelopeAlignment(
      "public.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(true);
  });

  test("misaligned subject is detected — federated envelope on local subject", () => {
    // The protocol violation IAW A.3 guards against: a federated envelope
    // accidentally published on a `local.*` subject would leak principal-
    // private semantics onto the federated bus, or vice versa.
    const env = envWithClassification("federated");
    const result = validateSubjectEnvelopeAlignment(
      "local.metafactory.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(false);
    expect(result.expected).toBe("federated");
    expect(result.actual).toBe("local");
  });

  test("misaligned subject is detected — local envelope on public subject", () => {
    const env = envWithClassification("local");
    const result = validateSubjectEnvelopeAlignment(
      "public.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(false);
    expect(result.expected).toBe("local");
    expect(result.actual).toBe("public");
  });

  // -------------------------------------------------------------------------
  // Behavior-pinning tests (Sage R1 — PR #151 important finding).
  //
  // The shim delegates entirely to `subjectPrefixAligns` from
  // `@the-metafactory/myelin/subjects`. These tests assert concrete
  // alignment semantics that a future myelin behavior change (e.g.,
  // case-folding, partial-prefix matching, whitespace tolerance) would
  // silently inherit. Pin them here so cortex's bus invariants fail
  // fast at vendor-bump time rather than at production publish time.
  // -------------------------------------------------------------------------

  test("alignment is case-sensitive — uppercase classification does NOT match", () => {
    // If myelin ever case-folds, `LOCAL.metafactory.*` would start to
    // count as aligned with a `local`-classified envelope and this
    // assertion would fail, surfacing the semantic drift.
    const env = envWithClassification("local");
    const result = validateSubjectEnvelopeAlignment(
      "LOCAL.metafactory.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(false);
    expect(result.actual).toBe("LOCAL");
  });

  test("alignment requires a dot boundary after the prefix — no partial matches", () => {
    // Pin: `local-host.something.*` MUST NOT count as aligned with a
    // `local`-classified envelope. Catches a future regression where a
    // pure `startsWith` check without dot-boundary enforcement creeps
    // back in.
    const env = envWithClassification("local");
    const result = validateSubjectEnvelopeAlignment(
      "local-host.metafactory.system.adapter.degraded",
      env,
    );
    expect(result.aligned).toBe(false);
    expect(result.expected).toBe("local");
    expect(result.actual).toBe("local-host");
  });

  test("bare classification subject (no payload segments) is aligned", () => {
    // Pin: subject === classification exactly should count as aligned.
    // Edge case where the dot-boundary check would naively fail.
    const env = envWithClassification("local");
    const result = validateSubjectEnvelopeAlignment("local", env);
    expect(result.aligned).toBe(true);
    expect(result.actual).toBe("local");
  });

  test("empty subject is misaligned (no prefix at all)", () => {
    const env = envWithClassification("local");
    const result = validateSubjectEnvelopeAlignment("", env);
    expect(result.aligned).toBe(false);
    expect(result.expected).toBe("local");
    expect(result.actual).toBe("");
  });
});
