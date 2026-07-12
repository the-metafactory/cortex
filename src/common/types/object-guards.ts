/**
 * Tiny structural type-guards shared across the config + types layers.
 *
 * Lifted here (cortex#1209 review nit) so the `isPlainObject` predicate has a
 * single definition instead of being re-declared in `surfaces.ts`,
 * `resolve-env-placeholders.ts`, and elsewhere.
 */

/**
 * True for a non-null, non-array object (a YAML mapping / JSON object). Narrows
 * `unknown` to `Record<string, unknown>` so callers can index it safely.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// cortex#1794 (S9 MOVE) added `requireStringBindingField` here as a band-aid
// for `gateway/binding-resolver.ts` + `gateway/surface-ownership-plan.ts`
// reading `surfaces.web[].binding` fields directly off an `unknown`-narrowed
// record. cortex#1951 replaced BOTH call sites with the registered plugin's
// own `demuxKey(binding)` (`AdapterPlugin`, `adapters/registry.ts`) — the
// binding shape now lives ONLY in each platform's plugin, never in gateway
// code — which made this helper unused. Removed rather than kept as
// speculative API surface; re-add if a genuine new caller needs it.
