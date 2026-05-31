/**
 * IAW Phase A.5 — stack identity primitive (refs cortex#113).
 *
 * Background (docs/design-internet-of-agentic-work.md §3.2, Q7 lock-in):
 * one principal can run multiple cortex stacks side-by-side
 * (`andreas/research`, `andreas/production`, `andreas/code`, …). The
 * subject-grammar extension that lets `local.{principal}.{stack}.…` envelopes
 * coexist with the legacy `local.{principal}.…` form lives in myelin
 * (myelin#113 — closed by myelin PR #114, squash `91bf2b42`, 2026-05-13).
 *
 * What this file delivers (A.5.3 + A.5.4):
 *   - `StackConfigSchema` — Zod schema for the optional top-level `stack:`
 *     block on `cortex.yaml`. `id` matches `{principal_id}/{stack_id}`,
 *     `nkey_pub` is an optional NATS NKey public key.
 *   - `deriveStackId(config)` — reader called at boot to resolve the
 *     effective stack identity. When the principal declares `stack: { id:
 *     andreas/research }`, the helper splits the literal. When the block is
 *     omitted, it default-derives `${principal.id}/default` so existing
 *     deployments preserve their identity verbatim (no behaviour change).
 *
 * Cutover state (post-PR #151, A.5.5 shipped):
 *   - **Subject derivation flips on the wire.** `MyelinRuntime.publish()`
 *     now derives subjects via the stack-aware `deriveNatsSubject({ stack })`
 *     ported from myelin (`b69c877`). Emitted envelopes carry the stack
 *     segment in `local.{principal}.{stack}.>` form. Principals with no
 *     `stack:` block fall through to the namespace spec's default-derived
 *     `${principal.id}/default` for backward compatibility (myelin
 *     `specs/namespace.md` §Backward-compat).
 *   - **Vendored envelope past `96b14ea`.** PR #128 bumped to `4578ae1`;
 *     PR #151 refreshed to `b69c877` to pick up stack-aware subject
 *     derivation.
 *
 * Carry-over to Phase B / ops:
 *   - **JetStream `TASKS` stream filter.** cortex#138 — the
 *     `local.*.tasks.>` → `local.*.*.tasks.>` filter cutover — is a
 *     principal-side NATS-server config change, not cortex code. Cortex
 *     publishes stack-aware subjects today but ships no TASKS-stream
 *     consumer of its own; the filter cutover lands when the first
 *     in-tree consumer arrives (Phase B / Phase C).
 */

import { z } from "zod/v4";
import { NKEY_PUBKEY_REGEX } from "./nkey";

// =============================================================================
// Schema
// =============================================================================

/**
 * Top-level `stack:` block on `cortex.yaml`. Both fields are optional in
 * spirit — the block as a whole is optional on `CortexConfigSchema`, so
 * omitting `stack:` entirely falls back to the `${principal.id}/default`
 * default-derivation. When the block IS present, `id` is required (you
 * cannot meaningfully name a stack without naming it); `nkey_pub` stays
 * optional for now — it will become required once Phase B (NKey-signed
 * bot↔bot) wires the stack-level signing material in.
 *
 * Grammar (IAW design §3.2 Model B, Q7 lock-in):
 *
 *   stack:
 *     id: andreas/research
 *     nkey_pub: UA…
 *
 * The `id` regex enforces `{principal_id}/{stack_id}` where each segment is
 * lowercase alphanumeric + hyphens/underscores, starting with a letter. Both
 * `PrincipalConfigSchema.id` and `StackConfigSchema.id` segments share the letter-
 * prefix rule (unified by cortex#141 before the IAW A.5.5 namespace cutover);
 * the stack-id half additionally permits underscores — principals tend to
 * spell stack names with `_` (e.g. `andreas/research_2026`) more naturally
 * than they spell their own identifier, so the asymmetry is retained on
 * purpose for underscores while being closed for the letter-prefix rule.
 *
 * Why each segment must start with a letter: NATS subject segments
 * starting with a digit interact poorly with some downstream subscribers'
 * pattern matching when the segment is treated as a numeric literal. Letter-
 * prefix is the safe boundary for the same reason agent ids enforce it.
 *
 * The `nkey_pub` regex matches the same 56-char NKey shape as
 * `NatsIdentitySchema.publicKey` (`U` + 55 base32 chars). The stack signing
 * key is provisioned per-stack and signed by the operator account NKey
 * (cortex#79 leaves the operator-account key in arc, with cortex receiving
 * only the per-stack pub key + creds). Schema-level format validation here
 * fails fast on a typo at config time rather than silently at signing
 * time. See `PrincipalConfigSchema.dataResidency` for the same fail-fast pattern.
 */
export const StackConfigSchema = z.object({
  /**
   * `{principal_id}/{stack_id}` — both segments lowercase, starting with a
   * letter, alphanumeric + hyphen/underscore. Embedded verbatim in NATS
   * subject segments once the myelin namespace extension (myelin#113)
   * lands, so the regex matches what a NATS subject can carry.
   */
  id: z.string().regex(
    /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/,
    "stack.id must match {principal_id}/{stack_id} format (lowercase alphanumeric + hyphens/underscores, each segment starts with letter)",
  ),
  /**
   * Stack-level NKey public key (`U` + 55 base32 chars). Optional in
   * Phase A; will be required once Phase B (cortex#102 — NKey-signed
   * bot↔bot) wires the stack signing material into envelope emission.
   *
   * Same regex as `NatsIdentitySchema.publicKey` so a typo at config time
   * fails fast — the format check predates the use-site, deliberately.
   */
  nkey_pub: z.string().regex(
    NKEY_PUBKEY_REGEX,
    "stack.nkey_pub must be a base32 NKey public key (U-prefixed, 56 chars total)",
  ).optional(),
  /**
   * IAW Phase B.3 (cortex#114) — path to the stack's private signing
   * seed file. NATS NKey seed (`SU` + 57 base32 chars) — same shape
   * `nsc generate nkey -u` produces. The file MUST be chmod 600 on
   * POSIX; the loader (`src/common/config/stack-signing-key.ts`)
   * enforces that gate before reading.
   *
   * Optional at config schema level so principals can stage `nkey_pub`
   * without immediately wiring the seed (e.g. on a dry run, or when
   * the bot is structurally configured but not yet expected to sign
   * outbound envelopes). When BOTH `nkey_pub` and `nkey_seed_path`
   * are set, `MyelinRuntime.publish()` signs every outbound envelope
   * with this stack's NKey; when only `nkey_pub` is set, the bot
   * publishes unsigned (B.1a / B.1b consume the `signed_by[]` only
   * structurally so unsigned envelopes still flow).
   *
   * Threat model: the seed is the most sensitive key material the
   * stack holds — possessing it lets an attacker mint signed
   * envelopes claiming this stack's identity. The chmod 600 gate is
   * the principal-laptop / server-filesystem mitigation; hardware-
   * backed signing (yubikey / TPM) is future work tracked by the
   * `loadStackSigningKey` seam.
   */
  nkey_seed_path: z.string().optional(),
});

export type StackConfig = z.infer<typeof StackConfigSchema>;

// =============================================================================
// Derivation
// =============================================================================

/**
 * Resolved stack identity — returned by `deriveStackId`. The three fields
 * are redundant by design: callers that need the two segments separately
 * (subject derivation, NKey lookup) get them already-split; callers that
 * just want the canonical `{principal}/{stack}` literal use `id`. Splitting
 * on `/` is mechanical but the helper does it once at boot so consumers
 * never have to.
 */
export interface DerivedStackId {
  /** The `{principal_id}` segment. */
  principal: string;
  /** The `{stack_id}` segment. */
  stack: string;
  /** The canonical literal — `${principal}/${stack}`. */
  id: string;
}

/**
 * Minimum-surface input shape consumed by `deriveStackId`. Carrying the
 * literal `Pick<CortexConfig, "principal" | "stack">` would force callers to
 * synthesise the full `PrincipalConfigSchema`-conformant object (`dataResidency`,
 * `displayName`, etc.) even though the resolver only reads `principal?.id`.
 * The narrower shape lets the boot path pass a one-field principal stub
 * without re-running the schema parser. The shape is structurally compatible
 * with `CortexConfig` — call-sites that already have a parsed
 * `CortexConfig`/`LoadedConfig` pass it through unchanged.
 */
export interface DeriveStackIdInput {
  // v3.0.0 BREAKING (manifest PR-11) — renamed from the legacy field per
  // the top-level CortexConfig `principal:` rename. The internal segment
  // below is the principal-id-half of the `{principal}/{stack}` grammar.
  principal?: { id?: string };
  stack?: { id: string };
}

/**
 * Boot-time stack identity resolver (IAW A.5.4).
 *
 * Resolution order:
 *   1. **Explicit:** `config.stack?.id` set → split and return verbatim.
 *      The Zod schema enforces the `{principal}/{stack}` regex, so the
 *      split is guaranteed to yield two non-empty segments.
 *   2. **Default-derived:** no `stack:` block → `${principal.id}/default`.
 *      Preserves identity for existing deployments that haven't migrated
 *      to the new block yet. Once myelin#113 lands and A.5.5 wires the
 *      stack segment into subject derivation, today's
 *      `local.andreas.>` envelopes become `local.andreas.default.>`
 *      transparently.
 *   3. **Fallback-of-fallback:** `principal.id` is structurally required by
 *      `PrincipalConfigSchema` (regex-enforced, not optional), so the only way
 *      to reach the `default/default` branch is to pass a partially-
 *      constructed config object directly to this helper — e.g. a test
 *      fixture that simulates the pre-MIG-7.2 shape. The branch exists
 *      so the helper is total: it never throws on a missing principal id.
 *
 * Why this helper takes the narrowed `DeriveStackIdInput`, not `CortexConfig`:
 *   The `stack:` block lives on `CortexConfigSchema` only. The MIG-7.2
 *   loader (`loadCortexShape` in `src/common/config/loader.ts`) parses
 *   cortex-shape input via that schema, then projects to `AgentConfig` for
 *   downstream legacy consumers — but the stack block isn't part of
 *   `AgentConfig` (the MIG-7.2 anti-fields rule out adding it to the
 *   legacy shape). Callers wire `deriveStackId` in via the
 *   `LoadedConfig.stack` field the loader exposes (set when cortex shape
 *   was detected). The boot path constructs a small input object from the
 *   boot-resolved `principal.id` (cortex#429 — sourced via
 *   `LoadedConfig.principal.id`) plus the optional `stack:` block — no
 *   second schema parse required.
 *
 * The return type is plain — no error path, no `null`. Boot code logs the
 * derived id and proceeds; the caller never has to branch on a degenerate
 * shape.
 */
export function deriveStackId(config: DeriveStackIdInput): DerivedStackId {
  // Explicit stack block — split on `/` and return.
  if (config.stack?.id) {
    const [principalSeg, stack] = config.stack.id.split("/");
    // The regex guarantees both segments are present and non-empty, so
    // these are never undefined in practice; the `??` is structural-
    // soundness insurance only (a downstream change to the regex that
    // accidentally permits an empty segment would surface here instead
    // of crashing the caller with `undefined.toString()`).
    return {
      principal: principalSeg ?? "default",
      stack: stack ?? "default",
      id: config.stack.id,
    };
  }

  // No stack block — default-derive from principal.id. `principal?.id`
  // guards the test-only path where a caller passes a partial config object
  // without a populated principal block; production callers always have
  // principal.id present because `PrincipalConfigSchema.id` is regex-enforced.
  const principalSeg = config.principal?.id ?? "default";
  return {
    principal: principalSeg,
    stack: "default",
    id: `${principalSeg}/default`,
  };
}
