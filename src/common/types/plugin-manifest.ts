/**
 * cortex#1792 (S6, ADR-0024 D1/D5/D4) — the `cortex-plugin.yaml` manifest
 * schema, and the shape of `arc list --json`'s output that the loader
 * (`src/adapters/loader.ts`) discovers bundles through.
 *
 * ## `cortex-plugin.yaml`
 *
 * One manifest file for BOTH plugin kinds (ADR-0024 D5), discriminated by
 * `kind`. Field names follow the ADR's pinned `SurfacePluginBase` shape
 * (`docs/design-pluggable-adapters.md` §3.1) — `sdkRange`, not the `sdk`
 * shorthand the issue body used; "where the issue and the ADR disagree, the
 * ADR wins" (repo CLAUDE.md).
 *
 *   kind: adapter | renderer
 *   id: cli-tail                  # registry key — platform (adapter) or
 *                                  # rendererKind (renderer). Equals the
 *                                  # exported SurfacePlugin's own `id`.
 *   entry: ./index.ts              # relative path to the module whose
 *                                  # DEFAULT export is a SurfacePlugin
 *   sdkRange: "^1"                 # semver range over SURFACE_SDK_VERSION —
 *                                  # THE compat gate (ADR-0024 D1)
 *   cortex: ">=6.0.0"              # advisory only — never the load gate
 *
 * `.strict()` — an unknown key is a manifest error, not silently ignored,
 * matching the "loud typo" convention the rest of the config surface uses
 * (`SurfacesSchema`, `RendererSchema` registry pass).
 *
 * `entry` is deliberately hardened against path traversal at the SCHEMA
 * layer (belt) in addition to the loader's runtime realpath-containment
 * check (suspenders, `src/adapters/loader.ts`'s `resolveEntryWithinBundle`)
 * — a manifest that names an absolute path, a `..`-escaping relative path,
 * or embeds a null byte never reaches the filesystem resolution step at
 * all. Path traversal via `entry` is a named adversarial target for this
 * slice (issue #1792); reject it as early as possible.
 */

import { z } from "zod/v4";

export const PluginKindSchema = z.enum(["adapter", "renderer"]);

export const PluginManifestSchema = z
  .object({
    kind: PluginKindSchema,
    /**
     * Registry key. Lowercase kebab-case, matching the `id` convention
     * every in-tree `AdapterPlugin`/`RendererPlugin` already uses
     * (`discord`, `pagerduty`, …).
     */
    id: z
      .string()
      .min(1, "id is required")
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "id must be lowercase kebab-case, starting with a letter (e.g. \"cli-tail\")",
      ),
    entry: z
      .string()
      .min(1, "entry is required")
      .refine((p) => !p.startsWith("/"), "entry must be a relative path (not absolute)")
      .refine((p) => !/^[a-zA-Z]:[\\/]/.test(p), "entry must be a relative path (not a Windows drive path)")
      .refine((p) => !p.includes("\0"), "entry must not contain a null byte")
      .refine(
        (p) => !p.split(/[\\/]/).includes(".."),
        "entry must not contain \"..\" path segments (no escaping the bundle directory)",
      ),
    /** Semver range over `SURFACE_SDK_VERSION` — the sole authoritative
     *  compat gate (ADR-0024 D1). Checked by the loader via
     *  `Bun.semver.satisfies`, never by this schema (a schema can validate
     *  shape, not "does it currently satisfy the running daemon's version"). */
    sdkRange: z.string().min(1, "sdkRange is required (e.g. \"^1\")"),
    /** Advisory only (ADR-0024 D1) — arc install MAY surface it; the loader
     *  never gates on it. */
    cortex: z.string().min(1).optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// =============================================================================
// `arc list --json` output shape (arc#289) — verified empirically against a
// live `arc list --json` run (2026-07-12): `{packages: [{name, version,
// type, status, tier, repoUrl, installPath, library?}]}`. `.passthrough()`
// on both levels so an ADDITIVE arc field never breaks discovery — cortex
// reads a known subset and ignores the rest.
// =============================================================================

export const ArcPackageSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    type: z.string(),
    status: z.string(),
    /**
     * arc's own trust classification (`official` | `community` | `custom`
     * observed live). NOT used as a trust signal by the loader's first-party
     * check — verified empirically to be SELF-DECLARED inside the bundle's
     * own `arc-manifest.yaml` (`grep tier ~/.config/metafactory/pkg/repos/*\/arc-manifest.yaml`
     * shows ordinary community bundles declaring their own tier), not
     * assigned by any registry authority the bundle author doesn't control.
     * Carried here for completeness/logging only. See `loader.ts`'s
     * `isFirstPartyRendererBundle` doc for the full rationale.
     */
    tier: z.string(),
    repoUrl: z.string(),
    installPath: z.string().min(1),
    library: z.string().optional(),
  })
  .catchall(z.unknown());

export type ArcPackage = z.infer<typeof ArcPackageSchema>;

export const ArcListOutputSchema = z
  .object({
    packages: z.array(ArcPackageSchema),
  })
  .catchall(z.unknown());

export type ArcListOutput = z.infer<typeof ArcListOutputSchema>;
