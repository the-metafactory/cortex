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

/**
 * cortex#1794 (S9 MOVE) — safely narrow a required string field off an
 * `unknown`-valued binding record. Added when `web` extracted out of
 * `SurfacesSchema`'s hardcoded platform keys: `surfaces.web[].binding` is now
 * validated only structurally as `Record<string, unknown>` at the STRUCTURAL
 * pass (the per-field REAL validation moved to the REGISTRY pass — the
 * loaded plugin's own `bindingSchema` — see `surfaces.ts`'s module doc), so
 * `entry.binding.instanceId` and similar fields are `unknown`, not `string`,
 * to any cortex-core code reading them directly (gateway binding-resolver /
 * ownership-plan demux logic, which pre-dates the plugin registry and reads
 * concrete per-platform fields by design — see those modules' docs).
 *
 * Interpolating an `unknown` into a template literal (`${value}`) passes
 * `tsc` but fails `@typescript-eslint/restrict-template-expressions`; a bare
 * `String(value)` coercion would silently pass, but risks turning a
 * malformed/missing field into a nonsensical demux key (`"web:undefined"`,
 * `"web:[object Object]"`) instead of failing loudly — the exact silent-
 * misgroup risk `adapters/plugin-support.ts`'s `stringBindingField` guards
 * against for the OPTIONAL-with-fallback case. This helper is for the
 * REQUIRED case: by the time gateway code reads a binding, it is presumed
 * already validated (`validateSurfacesAgainstRegistry` ran at boot/config-
 * load), so a genuinely non-string value here means that validation was
 * skipped or a plugin's `bindingSchema` doesn't require a field cortex-core
 * code assumes it does — worth a loud failure, not a silently-wrong key.
 */
export function requireStringBindingField(
  binding: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const value = binding[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${context}: expected binding.${field} to be a non-empty string, got ${typeof value} — ` +
        "the config should have been rejected at the registry-validation pass before reaching here.",
    );
  }
  return value;
}
