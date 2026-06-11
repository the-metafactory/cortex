/**
 * CO-1 (epic cortex#939) — the capability **offering** policy model.
 *
 * An **offering** is the PROVIDER side of the capability handshake
 * (CONTEXT.md §Capability offering): the policy that elevates a flat,
 * scope-blind `runtime.capabilities[]` tag into *exposed work* — the triple
 * `(capability, offer-scope, accept-policy)`. It is the symmetric counterpart
 * of Offer-mode dispatch (a consumer can only *Offer* work to a capability a
 * provider has *offered*).
 *
 * This file is the DATA MODEL + VALIDATION only (design §9 CO-1). It is
 * deliberately inert:
 *
 *   - **No consumer wiring.** Which scope prefixes a capability's JetStream
 *     consumer binds on is CO-2; nothing here touches the dispatch path.
 *   - **No federation-config generation.** `cortex offer` regenerating
 *     `announce_capabilities` / `accept_subjects` / registry registration is
 *     CO-3; this is the source-of-truth shape those projections will read.
 *   - **Byte-identical boot (the CO-1 contract).** `policy.offerings` is
 *     OPTIONAL and fully-defaulted; absent ⇒ `undefined` ⇒ every capability resolves
 *     to `local`-only via {@link resolveOffering} — exactly today's behaviour.
 *
 * ## The model (design §2, ADR-0008 DD-CO-1)
 *
 *   offer-scope  = the TRUST TIER a capability is reachable at — a subset of
 *                  {local, federated, public}. A capability MAY be offered at
 *                  several scopes at once.
 *   accept-policy = WITHIN an offered scope, who may dispatch it. A CLOSED,
 *                  per-scope tagged union (NOT a free-form DSL):
 *                    local      → no accept-policy (it is *this* stack).
 *                    federated  → {kind:'network'} | {kind:'principals'}
 *                                 (default-deny: federated with no accept is a
 *                                  VALIDATION ERROR — you must name).
 *                    public     → {kind:'surface', predicate:<metadata-only>, limits}
 *                                 (the predicate is constrained to METADATA-
 *                                  evaluable forms — content-dependent
 *                                  predicates FAIL schema validation, ADR-0010
 *                                  DD-CO-8).
 *
 * ## Default-deny (ADR-0008 DD-CO-1)
 *
 * A capability not listed in `policy.offerings[]` (or listed with no scope)
 * resolves to **`local`-only**. The secure default is internal exposure;
 * widening to federated/public is a deliberate act. {@link resolveOffering} is
 * the pure resolver CO-2 consumes to decide consumer-binding.
 *
 * Refs: docs/design-capability-offering.md §2/§6/§9 ·
 *       docs/adr/0008-capability-offering-scope.md (DD-CO-1) ·
 *       docs/adr/0009-offerings-per-stack-no-shared-layer.md (DD-CO-7 — this is
 *         per-stack runtime config; the runtime never composes a shared layer) ·
 *       docs/adr/0010-public-accept-gate-two-stage.md (DD-CO-8 — metadata-only
 *         public predicates) · CONTEXT.md §Capability offering.
 */

import { z } from "zod/v4";

import { LETTER_PREFIX_ID_REGEX } from "./id";

// =============================================================================
// Capability-id + network-id grammars (reused from the capability primitive)
// =============================================================================

/**
 * Offering `capability` grammar — the same dot-separated lowercase-segment id
 * grammar as a {@link CapabilitySchema} `id` (`./capability.ts`). An offering
 * names a capability by id; it cannot name something that isn't a well-formed
 * capability id. Kept as a local copy of the regex (rather than importing the
 * private `CapabilityIdSchema`) so the two stay structurally identical without
 * coupling the offering schema to a non-exported symbol; the cross-field check
 * on `CortexConfigSchema` enforces that the named capability actually EXISTS.
 */
const OfferingCapabilityIdSchema = z
  .string()
  .min(1, "offering.capability is required and must be non-empty")
  .regex(
    /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/,
    "offering.capability must be a capability id — dot-separated lowercase segments, each starting with a letter and containing only lowercase alphanumeric + hyphen/underscore (e.g. 'code-review.typescript')",
  );

/**
 * A network id — matches the federated network id grammar
 * (`PolicyFederatedNetworkSchema.id` letter-prefix). Used by the offering's
 * top-level `network?` field and the `{kind:'network'}` federated accept.
 */
const OfferingNetworkIdSchema = z
  .string()
  .regex(
    LETTER_PREFIX_ID_REGEX,
    "offering network id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'metafactory-net')",
  );

/**
 * A principal id — same letter-prefix grammar as a principal id. Used by the
 * `{kind:'principals'}` federated accept-policy.
 */
const OfferingPrincipalIdSchema = z
  .string()
  .regex(
    LETTER_PREFIX_ID_REGEX,
    "offering principal id must be lowercase alphanumeric + hyphen, starting with a letter (e.g. 'jcfischer')",
  );

// =============================================================================
// OfferScope — the trust tier
// =============================================================================

/**
 * Offer-scope = the trust tier a capability is reachable at (design §2,
 * CONTEXT.md §Capability offering). NOT to be confused with transport-Scope's
 * `local` (whose outer limit is the principal): offer-scope `local` binds
 * NARROWER — the offering stack itself (multiple stacks = multiple locals).
 */
export const OfferScopeSchema = z.enum(["local", "federated", "public"]);

export type OfferScope = z.infer<typeof OfferScopeSchema>;

// =============================================================================
// AcceptPolicy — the CLOSED, per-scope tagged union
// =============================================================================

/**
 * Federated accept by NAMED network. Admits dispatch from any peer on the
 * registry roster of `network`. Default-deny means a `federated` scope MUST
 * carry one of the federated accept kinds — see the `superRefine` on the
 * offering list (federated-requires-naming).
 */
export const FederatedNetworkAcceptSchema = z
  .object({
    kind: z.literal("network"),
    network: OfferingNetworkIdSchema,
  })
  .strict();

/**
 * Federated accept by EXPLICIT principal allowlist. Admits dispatch only from
 * the named principals (resolved over the registry roster at runtime — CO-2/3).
 * At least one principal must be named: an empty `principals: []` is "name
 * nobody", which contradicts the act of widening to `federated`, so it is
 * rejected here rather than silently resolving to deny-all.
 */
export const FederatedPrincipalsAcceptSchema = z
  .object({
    kind: z.literal("principals"),
    principals: z
      .array(OfferingPrincipalIdSchema)
      .min(
        1,
        "federated accept {kind:'principals'} must name at least one principal — an empty list names nobody (use a different scope, or name the principals)",
      ),
  })
  .strict();

/**
 * The federated accept-policy: network-roster OR explicit principal allowlist.
 * Discriminated on `kind` so a malformed entry fails at the precise variant.
 */
export const FederatedAcceptSchema = z.discriminatedUnion("kind", [
  FederatedNetworkAcceptSchema,
  FederatedPrincipalsAcceptSchema,
]);

export type FederatedAccept = z.infer<typeof FederatedAcceptSchema>;

// -----------------------------------------------------------------------------
// Public accept-policy — the two-stage gate (ADR-0010 DD-CO-8)
// -----------------------------------------------------------------------------

/**
 * The CLOSED set of METADATA-evaluable public accept-predicate kinds. This is
 * the hard enforcement of ADR-0010 DD-CO-8: Stage-1 admission is decided in
 * code, pre-LLM, on surface-asserted trustworthy metadata ONLY — never on
 * attacker-controlled request content.
 *
 * The kinds correspond 1:1 to the metadata the surface (e.g. GitHub via the
 * gh-webhook tap) asserts and the HMAC validates:
 *
 *   - `repo-membership` — admit requests against repos matching a glob set
 *     (e.g. `the-metafactory/*`). The repo is surface-asserted, HMAC-proven.
 *   - `sender-allow`    — admit requests from an allowlist of surface sender
 *     identities (e.g. GitHub logins). The sender is surface-asserted.
 *   - `sender-block`    — deny requests from a blocklist of surface senders
 *     (admit everything else within the scope, subject to the other gates).
 *   - `rate`            — admit by a deterministic rate ceiling (no identity
 *     dimension; the rate dimension of the metadata gate).
 *
 * A predicate `kind` that would require reading the request's CONTENT (the PR
 * body/description/diff) is, by construction, NOT in this enum — so it cannot
 * be expressed, and a YAML author who tries gets a closed-set enum error at
 * schema-parse time (not a runtime surprise). That IS the enforcement: the
 * predicate vocabulary is exactly the metadata-evaluable set, with no escape
 * hatch for content.
 */
export const PublicPredicateKindSchema = z.enum([
  "repo-membership",
  "sender-allow",
  "sender-block",
  "rate",
]);

export type PublicPredicateKind = z.infer<typeof PublicPredicateKindSchema>;

/**
 * Admit requests whose surface-asserted repo matches one of `repos[]` (glob
 * patterns, e.g. `the-metafactory/*`). The repo is part of the HMAC-validated
 * webhook payload (ADR-0010 — surface-asserted, trustworthy), never derived
 * from the request body.
 */
const RepoMembershipPredicateSchema = z
  .object({
    kind: z.literal("repo-membership"),
    repos: z
      .array(z.string().min(1))
      .min(1, "repo-membership predicate must name at least one repo glob (e.g. 'the-metafactory/*')"),
  })
  .strict();

/**
 * Admit requests from surface sender identities (e.g. GitHub logins) on the
 * allowlist. The sender identity is surface-asserted + HMAC-validated.
 */
const SenderAllowPredicateSchema = z
  .object({
    kind: z.literal("sender-allow"),
    senders: z
      .array(z.string().min(1))
      .min(1, "sender-allow predicate must name at least one surface sender identity"),
  })
  .strict();

/**
 * Deny requests from surface sender identities on the blocklist; admit
 * everything else in-scope (subject to the other gates).
 */
const SenderBlockPredicateSchema = z
  .object({
    kind: z.literal("sender-block"),
    senders: z
      .array(z.string().min(1))
      .min(1, "sender-block predicate must name at least one surface sender identity"),
  })
  .strict();

/**
 * Admit by a deterministic rate ceiling — the identity-free dimension of the
 * metadata gate. At least one window must be set (an empty rate predicate is
 * no constraint, which is a different concept than a `rate` predicate).
 */
const RatePredicateSchema = z
  .object({
    kind: z.literal("rate"),
    per_minute: z.number().int().positive().optional(),
    per_hour: z.number().int().positive().optional(),
    per_day: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (r) => r.per_minute !== undefined || r.per_hour !== undefined || r.per_day !== undefined,
    {
      message:
        "rate predicate must declare at least one window (per_minute, per_hour, or per_day)",
    },
  );

/**
 * The public accept-predicate — the discriminated union of the CLOSED
 * metadata-only kinds. Because it is a discriminated union over
 * {@link PublicPredicateKindSchema}, a content-referencing predicate cannot be
 * constructed: there is no `kind` for it, so it fails the discriminator. That
 * is how ADR-0010 DD-CO-8 ("content-dependent accept-predicates FORBIDDEN") is
 * enforced *in the schema* rather than at runtime.
 */
export const PublicPredicateSchema = z.discriminatedUnion("kind", [
  RepoMembershipPredicateSchema,
  SenderAllowPredicateSchema,
  SenderBlockPredicateSchema,
  RatePredicateSchema,
]);

export type PublicPredicate = z.infer<typeof PublicPredicateSchema>;

/**
 * Public-scope rate/cost limits — the §5 gate-floor knobs (design §5 / §6 M6).
 * Bounds adversarial inputs + token cost for public work. Fully optional
 * (a public offering MAY ship without explicit limits in CO-1; CO-4 wires the
 * enforcement and may tighten this to required). At least one field, when the
 * block is present, must be set — an empty `limits: {}` is rejected so it
 * cannot masquerade as "limited".
 */
export const PublicLimitsSchema = z
  .object({
    /** Max concurrent public review sessions admitted. */
    max_concurrent: z.number().int().positive().optional(),
    /** Per-day request ceiling for this public offering. */
    per_day: z.number().int().positive().optional(),
    /** Token-budget cap (cents) per request — ties to the BudgetCheck gap. */
    cost_cents_per_request: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (l) =>
      l.max_concurrent !== undefined ||
      l.per_day !== undefined ||
      l.cost_cents_per_request !== undefined,
    {
      message:
        "public limits must declare at least one bound (max_concurrent, per_day, or cost_cents_per_request); omit the `limits:` block entirely to mean 'no explicit limit'",
    },
  );

export type PublicLimits = z.infer<typeof PublicLimitsSchema>;

/**
 * The public accept-policy `{kind:'surface', surface, predicate, limits?}`
 * (design §2). The `surface` names the trust anchor (e.g. `github`); the
 * `predicate` is the metadata-only Stage-1 gate; `limits` is the gate floor.
 */
export const PublicAcceptSchema = z
  .object({
    kind: z.literal("surface"),
    /**
     * The surface that anchors trust for this public offering (e.g. `github`).
     * The public requester holds no bus identity; the surface's HMAC-validated
     * assertion of who/what is the trust anchor (ADR-0010 DD-CO-8).
     */
    surface: z.string().min(1, "public accept.surface is required (e.g. 'github')"),
    /**
     * The metadata-only Stage-1 admission predicate. Constrained to
     * {@link PublicPredicateSchema} — content-dependent forms are not
     * expressible.
     */
    predicate: PublicPredicateSchema,
    /** Optional gate-floor limits (rate / cost / concurrency). */
    limits: PublicLimitsSchema.optional(),
  })
  .strict();

export type PublicAccept = z.infer<typeof PublicAcceptSchema>;

/**
 * The accept-policy — the CLOSED tagged union across all scopes:
 *
 *   federated → {kind:'network'} | {kind:'principals'}
 *   public    → {kind:'surface', ...}
 *
 * `local` has NO accept variant — it is *this* stack, so no who-within-tier
 * decision exists. (`local`-only offerings carry no `accept` at all.) Because
 * the three federated/public kinds are discriminated on `kind`, the union is
 * closed: there is no free-form string variant, and a content-dependent public
 * predicate has no `kind` to land on.
 */
export const AcceptPolicySchema = z.discriminatedUnion("kind", [
  FederatedNetworkAcceptSchema,
  FederatedPrincipalsAcceptSchema,
  PublicAcceptSchema,
]);

export type AcceptPolicy = z.infer<typeof AcceptPolicySchema>;

// =============================================================================
// Offering — the (capability × offer-scope × accept-policy) triple
// =============================================================================

/**
 * A single capability offering (design §2). The structural schema; the
 * cross-scope coherence rules (federated-requires-naming, scope↔accept-kind
 * agreement, no-duplicate-capability) live in {@link superRefineOfferings},
 * called from `PolicySchema.superRefine`; the "offered capability must exist"
 * cross-block check lives on `CortexConfigSchema` (where `capabilities[]` is in
 * scope).
 */
export const OfferingSchema = z
  .object({
    /**
     * The capability this offering exposes — a capability id. The cross-field
     * check on `CortexConfigSchema` enforces that it matches a declared
     * capability some agent in the stack provides.
     */
    capability: OfferingCapabilityIdSchema,
    /**
     * The offer-scope(s) at which the capability is reachable. ≥1 scope; an
     * offering with `scopes: []` is "offered nowhere", which is the same as
     * not offering it (default-deny → local) and so is rejected as a likely
     * mistake — drop the entry, or name the scopes.
     */
    scopes: z
      .array(OfferScopeSchema)
      .min(1, "offering.scopes must name at least one scope (local, federated, or public); omit the offering entirely to mean 'local-only' (the default-deny resolution)"),
    /**
     * The accept-policy — who, within an offered scope, may dispatch.
     * Optional at the field level because `local`-only offerings carry no
     * accept; the scope↔accept coherence rules in {@link superRefineOfferings}
     * enforce that `federated`/`public` scopes DO carry the matching accept.
     */
    accept: AcceptPolicySchema.optional(),
    /**
     * Optional convenience: the network this offering's federated scope binds
     * to, when the `{kind:'network'}` accept isn't used (or as documentation).
     * Carried for parity with the design's `network?` field; the federated
     * accept's own `network` is authoritative for the `{kind:'network'}` case.
     */
    network: OfferingNetworkIdSchema.optional(),
  })
  .strict();

export type Offering = z.infer<typeof OfferingSchema>;

// =============================================================================
// Cross-offering validation — federated-requires-naming, scope↔accept, dedup
// =============================================================================

/**
 * Minimal issue shape the {@link superRefineOfferings} helper emits, mirroring
 * the `ctx.addIssue` calls in `PolicySchema.superRefine`. Keeping the helper
 * decoupled from Zod's `RefinementCtx` import surface lets the policy schema
 * own the `ctx` and just forward issues; the helper stays unit-testable
 * against a plain collector.
 */
export interface OfferingIssue {
  message: string;
  /** Path RELATIVE to `policy` (the caller prepends `["offerings", ...]`). */
  path: (string | number)[];
}

/**
 * The cross-offering coherence rules (called from `PolicySchema.superRefine`):
 *
 *   1. **No duplicate capability.** Two offerings for the same capability are a
 *      config error (which one wins?). One offering per capability; widen its
 *      `scopes[]` instead of adding a second entry.
 *   2. **Scope↔accept agreement.**
 *        - `federated` in scopes  ⇒ MUST carry a federated accept
 *          ({kind:'network'|'principals'}) — DEFAULT-DENY: federated with no
 *          accept names nobody (ADR-0008 DD-CO-1, CONTEXT.md §Capability
 *          offering). This is the headline default-deny enforcement.
 *        - `public` in scopes     ⇒ MUST carry a public accept
 *          ({kind:'surface', ...}).
 *        - `accept` present but its `kind` doesn't match an offered scope ⇒
 *          error (a federated accept on a local-only offering is meaningless).
 *        - `local`-only offering   ⇒ MUST NOT carry an accept (nothing to gate).
 *
 * Note one offering carries at most ONE `accept`. An offering at BOTH
 * `federated` and `public` would need two different accept shapes, which a
 * single `accept` field can't express — so such an offering is rejected here
 * with a pointed message (split it into the per-scope-natural separate
 * offerings via distinct… no: distinct entries collide on capability). CO-1's
 * model is therefore: an offering names one accept; offering a capability at
 * both federated AND public is deferred (flagged, not silently mis-handled).
 */
export function superRefineOfferings(
  offerings: readonly Offering[],
): OfferingIssue[] {
  const issues: OfferingIssue[] = [];

  // 1. No duplicate capability.
  const seen = new Map<string, number>();
  offerings.forEach((o, i) => {
    const dupAt = seen.get(o.capability);
    if (dupAt !== undefined) {
      issues.push({
        message: `offering for capability "${o.capability}" already declared at offerings[${dupAt}] — one offering per capability; widen its scopes[] instead of adding a second entry`,
        path: [i, "capability"],
      });
    } else {
      seen.set(o.capability, i);
    }
  });

  // 2. Scope↔accept agreement (+ default-deny for federated).
  offerings.forEach((o, i) => {
    const scopeSet = new Set(o.scopes);
    const hasFederated = scopeSet.has("federated");
    const hasPublic = scopeSet.has("public");
    const acceptKind = o.accept?.kind;
    const acceptIsFederated =
      acceptKind === "network" || acceptKind === "principals";
    const acceptIsPublic = acceptKind === "surface";

    // A single offering cannot carry both a federated and a public scope —
    // it would need two distinct accept shapes, and `accept` is singular.
    if (hasFederated && hasPublic) {
      issues.push({
        message: `offering "${o.capability}" lists both 'federated' and 'public' scopes, but an offering carries a single accept-policy and these scopes need different accept shapes — declare them as separate concerns (offer one scope per capability entry in CO-1; multi-scope-with-distinct-accept is deferred)`,
        path: [i, "scopes"],
      });
      return;
    }

    if (hasFederated) {
      if (o.accept === undefined) {
        issues.push({
          message: `offering "${o.capability}" is offered at 'federated' scope but names no accept-policy — federated is DEFAULT-DENY: you must name a network ({kind:'network'}) or principals ({kind:'principals'}) (ADR-0008 DD-CO-1)`,
          path: [i, "accept"],
        });
      } else if (!acceptIsFederated) {
        issues.push({
          message: `offering "${o.capability}" is offered at 'federated' scope but its accept-policy is {kind:'${acceptKind}'} — federated scope requires a federated accept ({kind:'network'} or {kind:'principals'})`,
          path: [i, "accept", "kind"],
        });
      } else if (
        o.accept.kind === "network" &&
        o.network !== undefined &&
        o.network !== o.accept.network
      ) {
        // #962 review nit: the top-level `network?` and the {kind:'network'}
        // accept's own `network` are dual-source. The accept's network is
        // AUTHORITATIVE (routing uses it); the top-level field is design-parity
        // documentation only. Reject divergence rather than silently pick one —
        // a mismatch is a config error, not a value to merge.
        issues.push({
          message: `offering "${o.capability}" has a top-level network "${o.network}" that disagrees with its accept network "${o.accept.network}" — the accept-policy's network is authoritative; remove the top-level network or make them match`,
          path: [i, "network"],
        });
      }
      return;
    }

    if (hasPublic) {
      if (o.accept === undefined) {
        issues.push({
          message: `offering "${o.capability}" is offered at 'public' scope but names no accept-policy — public requires {kind:'surface', surface, predicate, limits} (the two-stage metadata gate, ADR-0010 DD-CO-8)`,
          path: [i, "accept"],
        });
      } else if (!acceptIsPublic) {
        issues.push({
          message: `offering "${o.capability}" is offered at 'public' scope but its accept-policy is {kind:'${acceptKind}'} — public scope requires a public accept ({kind:'surface', ...})`,
          path: [i, "accept", "kind"],
        });
      }
      return;
    }

    // local-only offering: an accept-policy is meaningless (it IS this stack).
    if (o.accept !== undefined) {
      issues.push({
        message: `offering "${o.capability}" is local-only but carries an accept-policy — 'local' is this stack, so there is nobody-within-tier to gate; drop the accept (or widen the scope)`,
        path: [i, "accept"],
      });
    }
  });

  return issues;
}

// =============================================================================
// resolveOffering — the default-deny resolver (the CO-2 consumption point)
// =============================================================================

/**
 * The resolved view of a capability's offering — what CO-2 reads to decide
 * which scope prefixes its JetStream consumer binds on.
 */
export interface ResolvedOffering {
  /** The capability id this resolves. */
  capability: string;
  /** The effective offer-scopes. Default-deny ⇒ `['local']`. */
  scopes: OfferScope[];
  /** The accept-policy, if the matched offering carried one. */
  accept?: AcceptPolicy;
}

/**
 * Resolve a capability against the stack's offerings list — the DEFAULT-DENY
 * resolver (ADR-0008 DD-CO-1).
 *
 * A capability NOT present in `offerings` (or — defensively — present with an
 * empty `scopes[]`, which the schema rejects but a programmatic caller could
 * still pass) resolves to **`local`-only**: `{capability, scopes:['local']}`,
 * no accept-policy. This is the contract that makes CO-1 byte-identical: with
 * `policy.offerings` absent, EVERY capability resolves local-only — exactly
 * today's behaviour. CO-2 consumes this to bind the consumer (today: always
 * `local`); nothing downstream changes until something is offered wider.
 *
 * Pure + total: no I/O, no throw. An unmatched capability is the common case
 * (default-deny), not an error.
 */
export function resolveOffering(
  capability: string,
  offerings: readonly Offering[] | undefined,
): ResolvedOffering {
  const match = offerings?.find((o) => o.capability === capability);
  if (match === undefined || match.scopes.length === 0) {
    return { capability, scopes: ["local"] };
  }
  return {
    capability,
    // Defensive copy so the caller can't mutate the offering's array.
    scopes: [...match.scopes],
    ...(match.accept !== undefined ? { accept: match.accept } : {}),
  };
}
