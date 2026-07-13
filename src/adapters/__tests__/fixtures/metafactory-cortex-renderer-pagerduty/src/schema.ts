/**
 * cortex#1894 (S12b, ADR-0024 D5 extraction lane) — the PagerDuty renderer's
 * plugin-OWNED config schema, relocated/duplicated here so
 * `src/renderers/pagerduty.ts` (now this bundle's `src/pagerduty.ts`) never
 * needs to reach into cortex core for it.
 *
 * ## `PagerDutyRendererSchema` — the plugin's own `configSchema`
 *
 * S4 (`adapters/registry.ts`'s `RendererPlugin.configSchema` docstring)
 * establishes the principle: a `RendererPlugin` carries its OWN per-kind
 * schema. The four adapter extractions (web/slack/mattermost/discord) did the
 * identical move for their `bindingSchema` (each bundle's `./schema`). Before
 * this slice, `common/types/cortex-config.ts` was `PagerDutyRendererSchema`'s
 * home and `src/renderers/pagerduty.ts` imported it back — a cross-boundary
 * import that made the renderer un-compilable against `surface-sdk` alone.
 * Moving the definition HERE inverts that dependency; cortex core's
 * `renderers[]` per-kind validation now runs through THIS schema, contributed
 * by the loaded plugin's `configSchema` (registry pass,
 * `src/renderers/index.ts`'s `resolveRendererPluginAndConfig`).
 *
 * ## `RendererVisibilitySchema` — a plugin-owned DUPLICATE, not a move
 *
 * The canonical `RendererVisibilitySchema` in `common/types/cortex-config.ts`
 * is consumed by the WHOLE config subsystem (`DashboardRendererSchema`,
 * surface-router visibility filtering) independently of whether the pagerduty
 * RENDERER is in-tree or a bundle. Moving it would break config loading; so it
 * STAYS in `cortex-config.ts`. This module's copy is an independent,
 * byte-identical-in-behaviour (same fields, same enums, same regexes) COPY
 * scoped to this one `configSchema`. A config that validated pre-extraction
 * validates identically post-extraction.
 */

import { z } from "zod/v4";

/**
 * IAW Phase A.4 (cortex#113, cortex#109 §B) — per-renderer visibility
 * constraints applied by the surface-router BEFORE `render()`. All fields
 * optional; unset = no constraint on that axis. Behaviour-identical copy of
 * cortex-config's `RendererVisibilitySchema`.
 */
export const RendererVisibilitySchema = z.object({
  /** ISO-3166-1 alpha-2 residency allowlist. */
  hide_residency_outside: z.array(
    z.string().regex(
      /^[A-Z]{2}$/,
      "residency entries must be 2-letter ISO-3166-1 alpha-2 country codes",
    ),
  ).optional(),
  /** Model-class allowlist (myelin's `model_class` enum verbatim). */
  require_model_class: z.array(z.enum(["local-only", "frontier", "any"])).optional(),
  /** Maximum classification tier rendered (`local < federated < public`). */
  max_classification: z.enum(["local", "federated", "public"]).optional(),
});

export type RendererVisibility = z.infer<typeof RendererVisibilitySchema>;

/**
 * PagerDuty renderer config — operational events out per G-1111 §4.6.
 * Subscribes to `system.adapter.degraded`, `system.process.crashed`, etc., and
 * routes them to PagerDuty via the events-v2 API.
 *
 * The required `routingKey` is the live PagerDuty secret. `createRenderer`
 * parses a raw `renderers[]` entry through this schema before construction; a
 * Zod validation failure never echoes the rejected value (only the field path
 * + message), so a malformed `routingKey` is never leaked into a thrown error.
 */
export const PagerDutyRendererSchema = z.object({
  kind: z.literal("pagerduty"),
  /**
   * cortex#1788 (S3, ADR-0024 OQ10) — optional instance id, defaulting to
   * `kind`. Two `kind: pagerduty` entries with different routing keys are
   * otherwise indistinguishable in router metrics / a future `unload` verb.
   */
  id: z.string().min(1).optional(),
  /** Integration / routing key for PagerDuty events-v2. REQUIRED secret. */
  routingKey: z.string().min(1),
  /** Subject patterns to subscribe to. Principal chooses what is page-worthy. */
  subscribe: z.array(z.string().min(1)).default([]),
  /** IAW Phase A.4 — optional visibility guardrails. */
  visibility: RendererVisibilitySchema.optional(),
});

export type PagerDutyRendererConfig = z.infer<typeof PagerDutyRendererSchema>;
