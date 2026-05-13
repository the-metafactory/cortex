/**
 * IAW Phase A.5 — stack identity primitive (refs cortex#113).
 *
 * Background (docs/design-internet-of-agentic-work.md §3.2, Q7 lock-in):
 * one operator can run multiple cortex stacks side-by-side
 * (`andreas/research`, `andreas/production`, `andreas/code`, …). The
 * subject-grammar extension that lets `local.{operator}.{stack}.…` envelopes
 * coexist with the current `local.{operator}.…` form is filed as a
 * **myelin** issue (myelin#113) and lands separately; this primitive ships
 * cortex-side ahead of that PR so the config surface is in place when the
 * envelope namespace lands.
 *
 * What this file delivers (A.5.3 + A.5.4):
 *   - `StackConfigSchema` — Zod schema for the optional top-level `stack:`
 *     block on `cortex.yaml`. `id` matches `{operator_id}/{stack_id}`,
 *     `nkey_pub` is an optional NATS NKey public key.
 *   - `deriveStackId(config)` — reader called at boot to resolve the
 *     effective stack identity. When the operator declares `stack: { id:
 *     andreas/research }`, the helper splits the literal. When the block is
 *     omitted, it default-derives `${operator.id}/default` so existing
 *     deployments preserve their identity verbatim (no behaviour change).
 *
 * What this file does NOT do:
 *   - **No subject derivation.** A.5.5 — `MyelinRuntime.publish()`
 *     consuming the stack segment — is blocked on myelin#113 and lands in
 *     a follow-up PR. Today `deriveStackId` is observed at boot and exposed
 *     on `LoadedConfig`/`StartCortexOptions` so call-sites can read it
 *     ahead of the namespace cutover, but no emit subject changes.
 *   - **No JetStream filter change.** The TASKS stream filter rewrite
 *     (`local.*.tasks.>` → `local.*.*.tasks.>`) is cortex#138 and ships
 *     separately.
 *   - **No envelope bump.** The vendored myelin envelope upgrade (A.5.2)
 *     waits on myelin#113.
 */

import { z } from "zod/v4";

// =============================================================================
// Schema
// =============================================================================

/**
 * Top-level `stack:` block on `cortex.yaml`. Both fields are optional in
 * spirit — the block as a whole is optional on `CortexConfigSchema`, so
 * omitting `stack:` entirely falls back to the `${operator.id}/default`
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
 * The `id` regex enforces `{operator_id}/{stack_id}` where each segment is
 * lowercase alphanumeric + hyphens/underscores, starting with a letter. This
 * matches the broader `{operator}` regex on `OperatorSchema.id` (lowercase
 * alphanumeric + hyphen) but additionally permits underscores in the
 * stack-id half — operators tend to spell stack names with `_` (e.g.
 * `andreas/research_2026`) more naturally than they spell their own
 * identifier.
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
 * time. See `OperatorSchema.dataResidency` for the same fail-fast pattern.
 */
export const StackConfigSchema = z.object({
  /**
   * `{operator_id}/{stack_id}` — both segments lowercase, starting with a
   * letter, alphanumeric + hyphen/underscore. Embedded verbatim in NATS
   * subject segments once the myelin namespace extension (myelin#113)
   * lands, so the regex matches what a NATS subject can carry.
   */
  id: z.string().regex(
    /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/,
    "stack.id must match {operator_id}/{stack_id} format (lowercase alphanumeric + hyphens/underscores, each segment starts with letter)",
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
    /^U[A-Z2-7]{55}$/,
    "stack.nkey_pub must be a base32 NKey public key (U-prefixed, 56 chars total)",
  ).optional(),
});

export type StackConfig = z.infer<typeof StackConfigSchema>;

// =============================================================================
// Derivation
// =============================================================================

/**
 * Resolved stack identity — returned by `deriveStackId`. The three fields
 * are redundant by design: callers that need the two segments separately
 * (subject derivation, NKey lookup) get them already-split; callers that
 * just want the canonical `{operator}/{stack}` literal use `id`. Splitting
 * on `/` is mechanical but the helper does it once at boot so consumers
 * never have to.
 */
export interface DerivedStackId {
  /** The `{operator_id}` segment. */
  operator: string;
  /** The `{stack_id}` segment. */
  stack: string;
  /** The canonical literal — `${operator}/${stack}`. */
  id: string;
}

/**
 * Minimum-surface input shape consumed by `deriveStackId`. Carrying the
 * literal `Pick<CortexConfig, "operator" | "stack">` would force callers to
 * synthesise the full `OperatorSchema`-conformant object (`dataResidency`,
 * `displayName`, etc.) even though the resolver only reads `operator?.id`.
 * The narrower shape lets the boot path pass a one-field operator stub
 * without re-running the schema parser. The shape is structurally compatible
 * with `CortexConfig` — call-sites that already have a parsed
 * `CortexConfig`/`LoadedConfig` pass it through unchanged.
 */
export interface DeriveStackIdInput {
  operator?: { id?: string };
  stack?: { id: string };
}

/**
 * Boot-time stack identity resolver (IAW A.5.4).
 *
 * Resolution order:
 *   1. **Explicit:** `config.stack?.id` set → split and return verbatim.
 *      The Zod schema enforces the `{operator}/{stack}` regex, so the
 *      split is guaranteed to yield two non-empty segments.
 *   2. **Default-derived:** no `stack:` block → `${operator.id}/default`.
 *      Preserves identity for existing deployments that haven't migrated
 *      to the new block yet. Once myelin#113 lands and A.5.5 wires the
 *      stack segment into subject derivation, today's
 *      `local.andreas.>` envelopes become `local.andreas.default.>`
 *      transparently.
 *   3. **Fallback-of-fallback:** `operator.id` is structurally required by
 *      `OperatorSchema` (regex-enforced, not optional), so the only way
 *      to reach the `default/default` branch is to pass a partially-
 *      constructed config object directly to this helper — e.g. a test
 *      fixture that simulates the pre-MIG-7.2 shape. The branch exists
 *      so the helper is total: it never throws on a missing operator id.
 *
 * Why this helper takes the narrowed `DeriveStackIdInput`, not `CortexConfig`:
 *   The `stack:` block lives on `CortexConfigSchema` only. The MIG-7.2
 *   loader (`loadCortexShape` in `src/common/config/loader.ts`) parses
 *   cortex-shape input via that schema, then projects to `BotConfig` for
 *   downstream legacy consumers — but the stack block isn't part of
 *   `BotConfig` (the MIG-7.2 anti-fields rule out adding it to the
 *   legacy shape). Callers wire `deriveStackId` in via the
 *   `LoadedConfig.stack` field the loader exposes (set when cortex shape
 *   was detected). The boot path constructs a small input object from the
 *   BotConfig projection's `agent.operatorId` (legacy field-name continuity)
 *   plus the optional `stack:` block — no second schema parse required.
 *
 * The return type is plain — no error path, no `null`. Boot code logs the
 * derived id and proceeds; the caller never has to branch on a degenerate
 * shape.
 */
export function deriveStackId(config: DeriveStackIdInput): DerivedStackId {
  // Explicit stack block — split on `/` and return.
  if (config.stack?.id) {
    const [operator, stack] = config.stack.id.split("/");
    // The regex guarantees both segments are present and non-empty, so
    // these are never undefined in practice; the `??` is structural-
    // soundness insurance only (a downstream change to the regex that
    // accidentally permits an empty segment would surface here instead
    // of crashing the caller with `undefined.toString()`).
    return {
      operator: operator ?? "default",
      stack: stack ?? "default",
      id: config.stack.id,
    };
  }

  // No stack block — default-derive from operator.id. `operator?.id` guards
  // the test-only path where a caller passes a partial config object
  // without a populated operator block; production callers always have
  // operator.id present because `OperatorSchema.id` is regex-enforced.
  const operator = config.operator?.id ?? "default";
  return {
    operator,
    stack: "default",
    id: `${operator}/default`,
  };
}
