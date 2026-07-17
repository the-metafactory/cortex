/**
 * IAW Phase A.6 — capability declaration primitive (refs cortex#113).
 *
 * Background (docs/design-internet-of-agentic-work.md §5 Q2 lock-in,
 * 2026-05-13 Andreas):
 *
 *   "Two-part: (a) network capabilities = aggregated across all agents in all
 *   stacks part of the network; (b) principal can ALSO declare stack-level
 *   capabilities (and per-agent capability annotations) in cortex.yaml using
 *   a constrained schema — defined interface, NOT free text. 'Keep it simple.'
 *   Schema covers: capability id, description, tags (e.g., language tags),
 *   provided_by agent ids, optional rate/cost."
 *
 * The Q2 lock-in is explicit: schema-bounded, NOT free-text, so the future
 * network registry (Q3) can index capabilities deterministically and
 * orchestrator agents (§3.6) can reason about delegation without natural-
 * language disambiguation.
 *
 * What this file delivers (A.6.1 + A.6.2):
 *   - `CapabilitySchema` — Zod schema for a single capability declaration.
 *     Required fields: `id`, `description`, `tags`, `provided_by`.
 *     Optional fields: `rate`, `cost` — both structured envelopes, never
 *     free-text strings.
 *
 * What this file does NOT do:
 *   - **No runtime capability matching / dispatch logic.** That's a future
 *     phase (Phase E orchestrator pattern, §3.6 of the design doc). A.6 is
 *     schema-only: the catalog is parsed and queryable, but nothing on the
 *     dispatch path consumes it yet.
 *   - **No network registry registration.** Phase D, D.4 cloud-side
 *     registry service.
 *   - **Mirrors `AgentSchema.id` grammar.** `provided_by` uses the same
 *     letter-prefix regex `LETTER_PREFIX_ID_REGEX` as `AgentSchema.id` so the
 *     two cannot drift — closing the principal/stack/agent letter-prefix
 *     trilogy (cortex#141 → cortex#144 → cortex#145). A future change to
 *     the agent-id grammar is a single coordinated edit to both regexes.
 *
 * The per-agent reference validation (A.6.3) — every id in an agent's
 * `runtime.capabilities[]` must exist in the top-level `capabilities[]` block
 * — lives on `CortexConfigSchema` itself (a `.refine()` over the parsed
 * config), not here. Keeping the structural schema and the cross-field guard
 * separate mirrors how `CortexConfigSchema` already handles the unique-agent-
 * ids invariant in `cortex-config.ts`.
 */

import { z } from "zod/v4";
import { LETTER_PREFIX_ID_REGEX } from "./id";

// =============================================================================
// Sub-schemas — rate / cost envelopes
// =============================================================================

/**
 * Optional rate envelope. The design doc Q2 leaves the form unspecified
 * beyond "rate (requests per unit time)"; we anchor on a small fixed set of
 * windows so the schema is deterministic and orchestrator agents can compare
 * rates without parsing free-text duration strings.
 *
 * Why three windows: most reasonable rate ceilings on agent capabilities
 * (LLM-driven code review, embedding lookup, etc.) fall into one of these
 * buckets. A capability author picks the window that's natural for the
 * dominant constraint — short windows for burst-rate limits, longer for
 * daily quotas. Mixed windows are allowed (e.g. 10/min AND 5000/day), which
 * is the realistic shape for downstream-API-bounded capabilities.
 *
 * Why `positive int`: requests-per-window is a count; zero is not a valid
 * rate (zero would be "the capability does not exist", which is a different
 * concept than "rate-limited") and fractional rates are not meaningful at
 * the window granularity we offer. Principals wanting fractional ceilings
 * pick a larger window (1/min → 60/hour).
 *
 * At least one field must be set — an empty rate envelope (`rate: {}`) is
 * the same shape as no envelope at all, so we reject it explicitly with a
 * pointed error message rather than silently treating it as no constraint.
 */
const CapabilityRateSchema = z
  .object({
    per_minute: z.number().int().positive().optional(),
    per_hour: z.number().int().positive().optional(),
    per_day: z.number().int().positive().optional(),
  })
  .refine(
    (r) => r.per_minute !== undefined || r.per_hour !== undefined || r.per_day !== undefined,
    {
      message:
        "capability.rate must declare at least one window (per_minute, per_hour, or per_day); omit the `rate:` block entirely to mean 'no rate constraint'",
    },
  );

export type CapabilityRate = z.infer<typeof CapabilityRateSchema>;

/**
 * Optional cost envelope. The design doc Q2 leaves the form unspecified
 * beyond "cost (cents per request, or token-class pricing)"; we anchor on
 * two unit forms: per-request flat fees and per-token rates.
 *
 * No currency field. The first deployment is single-currency (cents = USD
 * cents); principals with a different currency convert at config time. Adding
 * a currency field at this stage would over-engineer the schema (Q2 calls
 * "keep it simple") and create a second migration when we add it for real.
 *
 * `nonnegative` rather than `positive`: a $0/request capability is a real
 * thing (free local-only models, intra-org capabilities, etc.) and should
 * declare zero rather than omitting the field — declared-zero communicates
 * "we considered cost and it's zero" vs. omitted communicates "we didn't
 * think about cost yet". The distinction matters when the orchestrator
 * agent reads the field to make routing decisions.
 *
 * At least one field required — same rationale as `CapabilityRateSchema`:
 * an empty `cost: {}` block is rejected explicitly.
 */
const CapabilityCostSchema = z
  .object({
    cents_per_request: z.number().nonnegative().optional(),
    cents_per_token: z.number().nonnegative().optional(),
  })
  .refine(
    (c) => c.cents_per_request !== undefined || c.cents_per_token !== undefined,
    {
      message:
        "capability.cost must declare at least one unit (cents_per_request or cents_per_token); omit the `cost:` block entirely to mean 'no cost declared'",
    },
  );

export type CapabilityCost = z.infer<typeof CapabilityCostSchema>;

// =============================================================================
// Capability id + tag + provider grammars
// =============================================================================

/**
 * Capability id grammar — dot-separated lowercase segments, each starting
 * with a letter, each lowercase alphanumeric + hyphen/underscore.
 *
 * Examples:
 *   code-review.typescript     ← canonical (design doc §5 Q2 example)
 *   literature-search.medline  ← canonical
 *   code-review                ← bare (no sub-capability)
 *   image-gen.dall_e_3         ← underscores permitted inside segments
 *
 * Counter-examples:
 *   Code-Review                ← uppercase rejected
 *   code review                ← whitespace rejected
 *   2d-rendering               ← digit-prefix rejected (letter-prefix rule)
 *   .code-review               ← leading dot rejected
 *   code-review.               ← trailing dot rejected
 *   code-review..typescript    ← consecutive dots rejected
 *
 * The dot-separated form lets capability ids carry a natural taxonomy
 * (root capability → sub-capability) without committing to a fixed depth.
 * The orchestrator agent (§3.6) can match either at the precise id level
 * (`code-review.typescript`) or on a tag prefix (`code-review`); the tag
 * vocabulary on each declaration is the source for tag-prefix matching,
 * not the id itself.
 *
 * Letter-prefix rule mirrors the same NATS-pattern-matcher concern that
 * justifies the rule on `PrincipalConfigSchema.id` and `StackConfigSchema.id`:
 * capability ids can plausibly appear as subject segments in a future
 * federated capability namespace (`federated.{principal}.{stack}.tasks.
 * code-review.typescript.>`); even though A.6 doesn't wire that today,
 * the letter-prefix rule keeps the door open without a follow-up schema
 * tightening. Hyphens AND underscores are both permitted inside segments
 * for natural readability (`code-review` vs `code_review` is a style
 * choice, not a structural one).
 */
/**
 * Exported for structural reuse (cortex#1033 §Security): brain-hosted agents'
 * `runtime.capabilities` become EXACT NATS subject segments — they must match
 * this grammar so a fragment can never smuggle a `>`/`*` wildcard into a pull
 * filter and claim tasks beyond its declared capability.
 */
// TODO(#2034/flag-day): replace with @the-metafactory/myelin/wire capability
// terminal once RFC-0001 lands (blocked-on #2020 capability-regex tightening).
// ./wire is kebab-strict; this local copy is looser (accepts `_`).
export const CAPABILITY_ID_REGEX = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

const CapabilityIdSchema = z
  .string()
  .min(1, "capability id is required and must be non-empty")
  .regex(
    CAPABILITY_ID_REGEX,
    "capability id must be dot-separated lowercase segments, each starting with a letter and containing only lowercase alphanumeric + hyphen/underscore (e.g. 'code-review.typescript', 'literature-search.medline'); reject uppercase, whitespace, digit-prefix segments, and leading/trailing/consecutive dots",
  );

/**
 * Tag grammar — a single lowercase segment, letter-prefixed, hyphen and
 * underscore permitted. No dots: tags are flat labels, not taxonomies.
 *
 * Examples accepted: `typescript`, `code-review`, `ts`, `frontier`,
 *   `python_3`, `domain-research`.
 * Counter-examples: `TypeScript`, `2d`, `code review`, `code.review`.
 *
 * Why letter-prefix here too: tags are likely to appear in NATS subject
 * segments in a future capability-tag indexing path (the network registry
 * Q3 may publish `federated.tags.typescript.>` aggregations). Same rule,
 * same rationale.
 */
const CapabilityTagSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "capability tags must be lowercase alphanumeric + hyphen/underscore, starting with a letter (e.g. 'typescript', 'code-review', 'frontier')",
  );

/**
 * Provider-id grammar — references an agent's `id` declared in the same
 * `cortex.yaml`'s `agents[]` array. The format mirrors `AgentSchema.id`:
 * `LETTER_PREFIX_ID_REGEX` (letter-prefix). cortex#145 closed the principal/
 * stack/agent letter-prefix trilogy (cortex#141 → cortex#144 → cortex#145);
 * `provided_by` tightened in the same PR for one-segment grammar parity.
 *
 * The existence-check that each `provided_by` value resolves to a declared
 * agent id is enforced cross-field on `CortexConfigSchema` (a `.refine()`
 * that walks `agents[].id` against every capability declaration's
 * `provided_by[]`). The structural format check here catches typos and
 * non-agent-id shapes at the field level; the cross-field refine catches
 * dangling references at the document level.
 */
const CapabilityProviderIdSchema = z
  .string()
  .regex(
    LETTER_PREFIX_ID_REGEX,
    "capability.provided_by entries must be agent ids — lowercase alphanumeric + hyphen, starting with a letter (matches AgentSchema.id grammar — principal/stack/agent letter-prefix trilogy closed by cortex#145); rename digit-prefixed ids like '2agent' to 'team-2agent' or 'agent-2026'",
  );

// =============================================================================
// CapabilitySchema — the constrained-schema declaration
// =============================================================================

/**
 * A single capability declaration. The shape is constrained per Q2 lock-in:
 * no free-text JSON, no open-ended extensions, no nested document trees.
 * Adding a new field requires a schema edit + test, which is the deliberate
 * design choice — orchestrator agents and the network registry index
 * against this shape, so it changes by intent, not by accident.
 *
 * Field rationale:
 *   - `id`: stable network-wide name (Q3 registry indexes by id).
 *   - `description`: short human-readable summary surfaced on the dashboard
 *     and in registry queries. Non-empty so a principal can't accidentally
 *     publish a `description: ""` field that surfaces as a blank line in
 *     the registry UI.
 *   - `tags`: taxonomic labels for tag-prefix matching. May be empty (a
 *     capability without tags is still a valid declaration), but every
 *     entry must conform to the tag grammar. Whether duplicate tags are
 *     allowed: yes — the schema does not de-dupe (a principal writing
 *     `[typescript, typescript]` parses cleanly; the registry layer can
 *     dedupe at query time). The design doc does not call out dedup as a
 *     concern; we keep the schema additive.
 *   - `provided_by`: ≥1 agent id. A capability with no provider is not a
 *     declarable thing — the capability would have no implementation. The
 *     ≥1 minimum is a deliberate fail-fast: a principal removing the last
 *     agent from `provided_by` is removing the capability, and that's a
 *     schema-level signal, not a runtime one.
 *   - `rate` (optional): rate envelope. Omit = no constraint.
 *   - `cost` (optional): cost envelope. Omit = no declared cost.
 */
export const CapabilitySchema = z.object({
  /**
   * Stable capability id (Q2). Network-wide unique within a stack — the
   * uniqueness invariant lives at `CortexConfigSchema` because uniqueness
   * is a document-level check, not a field-level one.
   */
  id: CapabilityIdSchema,
  /**
   * Short human-readable summary. Non-empty so blank descriptions can't
   * silently propagate into the registry / dashboard. `.trim().min(1)` rejects
   * whitespace-only strings (`" "`, `"\t"`, etc.) which would otherwise pass
   * `.min(1)` despite being functionally blank in the UI surfaces consuming
   * the field. Principals wanting a very brief label can write
   * `description: "."` to satisfy the rule; the design doesn't require a
   * minimum prose length beyond "non-empty after trim".
   */
  description: z
    .string()
    .trim()
    .min(1, "capability.description is required and must be non-empty"),
  /**
   * Taxonomic tags. May be empty array; every entry must conform to the
   * tag grammar. Dedup is not enforced (registry can dedupe at query time).
   */
  tags: z.array(CapabilityTagSchema).default([]),
  /**
   * Agent ids inside this stack that provide the capability. At least one
   * provider required — a capability with no provider is not a declarable
   * concept. The cross-field refine on `CortexConfigSchema` enforces that
   * every value resolves to a declared `agents[].id`.
   */
  provided_by: z
    .array(CapabilityProviderIdSchema)
    .min(1, "capability.provided_by must list at least one provider agent id"),
  /**
   * Optional rate envelope. When present, at least one of `per_minute`,
   * `per_hour`, `per_day` must be set (enforced by `CapabilityRateSchema`).
   */
  rate: CapabilityRateSchema.optional(),
  /**
   * Optional cost envelope. When present, at least one of
   * `cents_per_request`, `cents_per_token` must be set (enforced by
   * `CapabilityCostSchema`).
   */
  cost: CapabilityCostSchema.optional(),
});

export type Capability = z.infer<typeof CapabilitySchema>;
