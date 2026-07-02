/**
 * R26 P1 (cortex#1371) — the `policy.admission` config schema + limit
 * resolution for the substrate admission gate.
 *
 * Design: `docs/design-substrate-rate-limiting.md` §4.1 (Design B, signed off
 * 2026-07-02). Contract: myelin `specs/admission.md` (myelin#195) — this module
 * owns only the CONFIG side (which principal gets which windows); the shared
 * KV state machinery lives in `src/bus/admission/`.
 *
 * ## Shape
 *
 * ```yaml
 * policy:
 *   admission:
 *     stack:                    # tier 1 — global spawn ceiling
 *       max_concurrent: 8
 *       per_minute: 30
 *     defaults:                 # tier 2 — every principal unless overridden
 *       per_minute: 6
 *       max_concurrent: 3
 *     roles:                    # role-level overrides (most permissive wins,
 *       principal:              # same union direction as capability grants)
 *         per_minute: 20
 *     principals:               # per-principal override (most specific wins)
 *       - id: amt-surface
 *         per_minute: 12
 *     anonymous:                # the open-onboarding floor — clamped to the
 *       per_minute: 2           # built-in ceiling regardless of config
 *       max_concurrent: 1
 * ```
 *
 * ## The CO-4 inertness contract
 *
 * The block is `.optional()` with NO default: an absent `admission:` block
 * parses to `undefined`, `cortex.ts` never constructs an `AdmissionGate`, and
 * behaviour is byte-identical to a build predating R26 (the same
 * provably-inert-until-configured rule the gate floor documents at
 * `gate-floor.ts:29-37`). The resolver — not a schema default — owns the
 * "nothing configured ⇒ nothing limited" semantics.
 *
 * ## Vocabulary
 *
 * The window fields reuse the `offering.ts` rate vocabulary exactly
 * (`per_minute`/`per_hour`/`per_day` from `RatePredicateSchema`,
 * `max_concurrent` from `PublicLimitsSchema`) so a stack tunes ONE dialect
 * across public-offering limits and admission limits.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Limits — the per-window vocabulary
// ---------------------------------------------------------------------------

/**
 * A bundle of admission limits. Every field optional, but an EMPTY bundle is
 * rejected — `{}` would masquerade as "limited" while limiting nothing (the
 * same rule `PublicLimitsSchema` enforces). Omit the block entirely to mean
 * "no explicit limit at this level".
 */
export const AdmissionLimitsSchema = z
  .object({
    /** Requests per rolling minute (token bucket, capacity = value). */
    per_minute: z.number().int().positive().optional(),
    /** Requests per rolling hour. */
    per_hour: z.number().int().positive().optional(),
    /** Requests per rolling day. */
    per_day: z.number().int().positive().optional(),
    /** Max concurrently in-flight dispatches (KV lease counter). */
    max_concurrent: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (l) =>
      l.per_minute !== undefined ||
      l.per_hour !== undefined ||
      l.per_day !== undefined ||
      l.max_concurrent !== undefined,
    {
      message:
        "admission limits must declare at least one bound (per_minute, per_hour, per_day, or max_concurrent); omit the block entirely to mean 'no explicit limit'",
    },
  );

export type AdmissionLimits = z.infer<typeof AdmissionLimitsSchema>;

/** A per-principal override entry — an id plus the limit vocabulary. */
export const AdmissionPrincipalOverrideSchema = z
  .object({
    /** Principal id (bare, no `did:mf:` prefix) — must be declared in `policy.principals[]`. */
    id: z.string().min(1),
    per_minute: z.number().int().positive().optional(),
    per_hour: z.number().int().positive().optional(),
    per_day: z.number().int().positive().optional(),
    max_concurrent: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (l) =>
      l.per_minute !== undefined ||
      l.per_hour !== undefined ||
      l.per_day !== undefined ||
      l.max_concurrent !== undefined,
    {
      message:
        "admission principal override must declare at least one bound (per_minute, per_hour, per_day, or max_concurrent)",
    },
  );

export type AdmissionPrincipalOverride = z.infer<
  typeof AdmissionPrincipalOverrideSchema
>;

// ---------------------------------------------------------------------------
// The policy.admission block
// ---------------------------------------------------------------------------

export const AdmissionPolicySchema = z
  .object({
    /** Tier 1 — the global stack spawn ceiling. Applies to EVERY dispatch. */
    stack: AdmissionLimitsSchema.optional(),
    /** Tier 2 baseline — every principal unless a role/principal override wins. */
    defaults: AdmissionLimitsSchema.optional(),
    /**
     * Tier 2 role overrides, keyed by role id (must be declared in
     * `policy.roles[]` — cross-checked in `PolicySchema.superRefine`). When a
     * principal holds several roles, the MOST PERMISSIVE value per field wins
     * — the same union direction as capability grants (`engine.ts`).
     */
    roles: z.record(z.string(), AdmissionLimitsSchema).optional(),
    /**
     * Tier 2 per-principal overrides (most specific — beats roles and
     * defaults, field by field). Ids must be declared in
     * `policy.principals[]` (cross-checked in `PolicySchema.superRefine`).
     */
    principals: z.array(AdmissionPrincipalOverrideSchema).optional(),
    /**
     * The open-onboarding (anonymous `did:mf:public`) floor. CLAMPED at
     * runtime to the built-in ceiling ({@link ANONYMOUS_ADMISSION_CEILING}:
     * 2/min, 1 in-flight) — config can tighten it, never raise it. Absent ⇒
     * the ceiling applies as-is whenever an `admission:` block is configured.
     */
    anonymous: AdmissionLimitsSchema.optional(),
  })
  .strict();

export type AdmissionPolicy = z.infer<typeof AdmissionPolicySchema>;

// ---------------------------------------------------------------------------
// Resolution — which limits govern a given requester
// ---------------------------------------------------------------------------

/**
 * The built-in anonymous ceiling (design §3.1): the zero-authority public
 * principal gets a hard-tight default REGARDLESS of config — 2 dispatches a
 * minute, 1 in flight. Config may add tighter windows (`per_hour`/`per_day`
 * only further restrict) but can never raise these two.
 */
export const ANONYMOUS_ADMISSION_CEILING = {
  per_minute: 2,
  max_concurrent: 1,
} as const;

/** Inputs to {@link resolveAdmissionLimits}. */
export interface ResolveAdmissionLimitsInput {
  /** Bare requester principal id (envelope-resolved; see myelin admission spec §1). */
  principalId: string;
  /** True when the requester resolved to the anonymous public principal. */
  anonymous: boolean;
  /** Role ids the principal holds (from `policy.principals[].role`). */
  roles: readonly string[];
}

const LIMIT_FIELDS = [
  "per_minute",
  "per_hour",
  "per_day",
  "max_concurrent",
] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

/**
 * Resolve the tier-2 (per-principal) limits for a requester, per design §4.1:
 * `principals[id]` > `roles` (most permissive across the principal's roles)
 * > `defaults` — resolved FIELD BY FIELD, so a principal override that only
 * sets `per_minute` still inherits `max_concurrent` from its roles/defaults.
 *
 * The anonymous principal short-circuits to its own lane: the configured
 * `anonymous:` block clamped to {@link ANONYMOUS_ADMISSION_CEILING} (absent ⇒
 * the ceiling verbatim). `defaults`/`roles`/`principals` never apply to it —
 * the open-onboarding identity cannot be widened by a generous default.
 *
 * Returns `undefined` when NO field resolves — that tier is then inert for
 * this requester (no KV key is read or written).
 */
export function resolveAdmissionLimits(
  admission: AdmissionPolicy,
  input: ResolveAdmissionLimitsInput,
): AdmissionLimits | undefined {
  if (input.anonymous) {
    return clampAnonymousLimits(admission.anonymous);
  }

  const override = admission.principals?.find((p) => p.id === input.principalId);
  const resolved: Partial<Record<LimitField, number>> = {};
  for (const field of LIMIT_FIELDS) {
    const fromOverride = override?.[field];
    if (fromOverride !== undefined) {
      resolved[field] = fromOverride;
      continue;
    }
    // Most permissive across the principal's roles that set the field —
    // the capability-union direction (a second role never TIGHTENS what a
    // first role granted).
    let fromRoles: number | undefined;
    for (const roleId of input.roles) {
      const roleLimits = admission.roles?.[roleId];
      const v = roleLimits?.[field];
      if (v !== undefined && (fromRoles === undefined || v > fromRoles)) {
        fromRoles = v;
      }
    }
    if (fromRoles !== undefined) {
      resolved[field] = fromRoles;
      continue;
    }
    const fromDefaults = admission.defaults?.[field];
    if (fromDefaults !== undefined) {
      resolved[field] = fromDefaults;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Clamp the configured anonymous limits to the built-in ceiling. Absent
 * config ⇒ the ceiling verbatim; configured values are `min()`-ed against the
 * ceiling on the capped fields (`per_minute`, `max_concurrent`) and passed
 * through on the tighten-only fields (`per_hour`, `per_day` — extra windows
 * AND against the ceiling, so they can only restrict further).
 */
export function clampAnonymousLimits(
  configured: AdmissionLimits | undefined,
): AdmissionLimits {
  const clamped: AdmissionLimits = {
    per_minute: Math.min(
      configured?.per_minute ?? ANONYMOUS_ADMISSION_CEILING.per_minute,
      ANONYMOUS_ADMISSION_CEILING.per_minute,
    ),
    max_concurrent: Math.min(
      configured?.max_concurrent ?? ANONYMOUS_ADMISSION_CEILING.max_concurrent,
      ANONYMOUS_ADMISSION_CEILING.max_concurrent,
    ),
  };
  if (configured?.per_hour !== undefined) clamped.per_hour = configured.per_hour;
  if (configured?.per_day !== undefined) clamped.per_day = configured.per_day;
  return clamped;
}
