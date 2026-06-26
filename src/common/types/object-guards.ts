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
