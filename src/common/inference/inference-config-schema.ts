// API-P0.2 (epic #2055, D6) — the machine-layer `inference` config SCHEMA,
// extracted to a dependency-free LEAF module so BOTH top-level config shapes
// (`CortexConfigSchema` in `../types/cortex-config.ts` AND the legacy
// `AgentConfigSchema` in `../types/config.ts`) can carry an `inference` block by
// importing this file — WITHOUT the config↔cortex-config import cycle that a
// shared definition living in either of those files would create (API-P1.3,
// #2063). `cortex-config.ts` re-exports these symbols, so every existing
// `import … from "../types/cortex-config"` keeps working unchanged.
//
// This module depends only on zod + the two leaf inference modules
// (`./secret-ref`, `./types`) — never on a config module — so it can be imported
// from anywhere without a cycle.
//
// Security posture (design §"Secrets and egress", D6):
//   - `providers.*.apiKey` and every `providers.*.headers.*` value is a SECRET
//     REFERENCE (`env:NAME`, see {@link SecretRefSchema}), never a literal.
//     Resolution to the value happens at CALL TIME in the harness/factory
//     ({@link resolveSecretRef}); the parsed/serialized config holds only the
//     reference, so a config dump/log shows `env:NAME`, never the secret.
//   - `providers.*.baseUrl` is a reviewed MODEL-EGRESS destination — this block
//     is the single place those destinations are declared.
//   - Profiles are POLICY-BEARING: `modelClass` + `dataResidency` carry the
//     class + data residency the registry/harness enforce.
//
// Phase-0 decisions baked in (issue #2057 stop-and-ask):
//   - Q2 capabilities are CONFIGURED-ONLY (an optional static override), never
//     probed at startup.
//   - Q5 provider-specific knobs live under ONE namespaced opaque `options`
//     escape hatch per profile — no vendor wire fields as first-class config.

import { z } from "zod/v4";

import { SecretRefSchema } from "./secret-ref";
import type { ProviderCapabilities } from "./types";

/**
 * Optional static capability override for a provider. Keys align 1:1 with
 * {@link ProviderCapabilities} (API-P0.3); every field is optional so a config
 * declares only the flags it means to override. CONFIGURED-only (issue #2057
 * Q2) — cortex does NOT probe a provider at startup; whatever is (or isn't)
 * declared here is the whole truth. The `satisfies` check binds the shape to
 * `ProviderCapabilities` so a drift in the contract fails typecheck here.
 */
export const ProviderCapabilitiesOverrideSchema = z
  .object({
    streaming: z.boolean().optional(),
    tools: z.boolean().optional(),
    parallelTools: z.boolean().optional(),
    images: z.boolean().optional(),
    documents: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    serverContinuation: z.boolean().optional(),
    promptCaching: z.boolean().optional(),
  })
  .strict();

// Compile-time guard: the override keys are exactly the ProviderCapabilities
// keys (all made optional). If API-P0.3 adds/removes/renames a capability, this
// assignment fails typecheck until the override schema is updated in lockstep.
type _CapabilitiesOverrideMatchesContract = z.infer<
  typeof ProviderCapabilitiesOverrideSchema
> extends Partial<ProviderCapabilities>
  ? Partial<ProviderCapabilities> extends z.infer<typeof ProviderCapabilitiesOverrideSchema>
    ? true
    : never
  : never;
const _capabilitiesOverrideContractOk: _CapabilitiesOverrideMatchesContract = true;
void _capabilitiesOverrideContractOk;

/**
 * A model-provider declaration: the wire protocol, the reviewed egress
 * destination (`baseUrl`), and the SECRET-REFERENCE credentials. `apiKey` and
 * every `headers` value are `env:NAME` references (never literals) resolved at
 * call time — the parsed config never carries a resolved secret.
 */
export const InferenceProviderSchema = z
  .object({
    /** Wire protocol the harness speaks to this provider. */
    protocol: z.enum(["anthropic-messages", "openai-chat-completions"]),
    /** Reviewed model-egress destination. Declared here so egress review has one file. */
    baseUrl: z.url(),
    /** Provider API key — a `env:NAME` secret reference, resolved at call time, never a literal. */
    apiKey: SecretRefSchema,
    /**
     * Optional extra request headers. Values are ALSO secret references
     * (`env:NAME`) — a header can carry a token — resolved at call time, never
     * literals on the parsed config.
     */
    headers: z.record(z.string().min(1), SecretRefSchema).optional(),
    /** Optional static capability override (configured-only; no startup probe). */
    capabilities: ProviderCapabilitiesOverrideSchema.optional(),
  })
  .strict();

/**
 * A named inference profile: the policy-bearing selection of a provider + model
 * + generation bound + model class + data residency. `provider` must name a key
 * in the sibling `providers` map (enforced by the document-level refinement on
 * {@link InferenceConfigSchema}).
 */
export const InferenceProfileSchema = z
  .object({
    /** Key into the sibling `providers` map. Validated to exist at load. */
    provider: z.string().min(1),
    /** Provider-neutral model id. */
    model: z.string().min(1),
    /**
     * Upper bound on generated tokens — the principal's declared cost/length
     * bound. Reaches the wire as `max_tokens` on BOTH protocols (issue #2114).
     *
     * Optional, and what omission means is PER PROTOCOL (it is not uniform,
     * because the two APIs differ on whether the field is required):
     *   - `anthropic-messages`: the API REQUIRES `max_tokens`, so cortex sends
     *     its declared default — `DEFAULT_MAX_OUTPUT_TOKENS` (4096) in
     *     `src/providers/anthropic/messages-provider.ts`.
     *   - `openai-chat-completions`: the field is omitted entirely and the
     *     target server's own default applies (cortex bounds nothing).
     *
     * Prefer stating it. Omitting it means the bound is someone else's choice.
     */
    maxOutputTokens: z.number().int().positive().optional(),
    /** Policy: the egress class this profile is permitted. */
    modelClass: z.enum(["local-only", "frontier", "any"]),
    /** Policy: declared data-residency label (opaque string; e.g. `us`, `eu`). Optional. */
    dataResidency: z.string().min(1).optional(),
    /**
     * Q5 escape hatch: a SINGLE namespaced, opaque bag of provider-only knobs.
     * Keyed by provider namespace (e.g. `anthropic`); values are opaque and
     * never inspected as portable config. Mirrors `ProviderOptions` (API-P0.3).
     * Portable behaviour must NOT depend on anything here.
     */
    options: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

/**
 * The `inference` config block: a map of providers + a map of profiles.
 *
 * Document-level invariant (issue #2057 AC): every `profiles.*.provider` must
 * name an existing `providers.*` key. A dangling reference fails config load
 * with a descriptive, per-offender error rather than silently producing a
 * profile that can never resolve to a provider instance.
 */
export const InferenceConfigSchema = z
  .object({
    providers: z.record(z.string().min(1), InferenceProviderSchema).default({}),
    profiles: z.record(z.string().min(1), InferenceProfileSchema).default({}),
  })
  .superRefine((cfg, ctx) => {
    for (const [profileName, profile] of Object.entries(cfg.profiles)) {
      if (!(profile.provider in cfg.providers)) {
        const known = Object.keys(cfg.providers);
        ctx.addIssue({
          code: "custom",
          path: ["profiles", profileName, "provider"],
          message:
            `inference profile "${profileName}" references provider ` +
            `"${profile.provider}" which is not defined in inference.providers ` +
            `(known providers: ${known.length > 0 ? known.join(", ") : "<none>"}).`,
        });
      }
    }
  });

export type ProviderCapabilitiesOverride = z.infer<typeof ProviderCapabilitiesOverrideSchema>;
export type InferenceProvider = z.infer<typeof InferenceProviderSchema>;
export type InferenceProfile = z.infer<typeof InferenceProfileSchema>;
export type InferenceConfig = z.infer<typeof InferenceConfigSchema>;
