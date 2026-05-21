/**
 * R9 (cortex#388 PR-3) — principal env-var compat shim.
 *
 * The vocabulary migration renames the `operator`-the-human concept to
 * `principal`. On the env-var surface that means `CORTEX_OPERATOR_*` →
 * `CORTEX_PRINCIPAL_*`.
 *
 * This is the TRANSITION release: code reads the new `CORTEX_PRINCIPAL_*`
 * name and falls back to the legacy `CORTEX_OPERATOR_*` when only the old
 * one is set, emitting a one-line deprecation notice to stderr so the
 * operator knows to update their environment. The legacy fallback is
 * removed in the breaking v3.0.0 (PR-11) per the migration manifest.
 *
 * The deepest tier (`GROVE_OPERATOR`) is the pre-cortex name. It stays as
 * the last-resort fallback here because the separate `GROVE_*` → `CORTEX_*`
 * namespace migration (postinstall.sh notes; retires at MIG-8) owns its
 * removal — this shim does not pull that rename forward.
 */

/**
 * Resolve a `*_PRINCIPAL`-suffixed env var with a compat fallback chain.
 *
 * Lookup order (first defined wins):
 *   1. `CORTEX_PRINCIPAL{suffix}` — the canonical post-migration name.
 *   2. `CORTEX_OPERATOR{suffix}`  — legacy transitional name (deprecated;
 *      emits a one-line stderr warning when it is what supplied the value).
 *   3. `GROVE_OPERATOR{suffix}`   — pre-cortex name; owned by the separate
 *      `GROVE_*` → `CORTEX_*` namespace migration.
 *
 * @param suffix the variable suffix after the `CORTEX_PRINCIPAL` /
 *   `CORTEX_OPERATOR` / `GROVE_OPERATOR` stem, e.g. `""` for the bare
 *   name or `"_ID"` for `CORTEX_PRINCIPAL_ID`.
 * @param env the environment to read; defaults to `process.env`. Injectable
 *   for tests.
 * @returns the resolved value, or `undefined` when no tier is set.
 */
export function resolvePrincipalEnv(
  suffix = "",
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const canonical = env[`CORTEX_PRINCIPAL${suffix}`];
  if (canonical !== undefined) return canonical;

  const legacyCortex = env[`CORTEX_OPERATOR${suffix}`];
  if (legacyCortex !== undefined) {
    process.stderr.write(
      `cortex: env var CORTEX_OPERATOR${suffix} is deprecated — ` +
        `rename it to CORTEX_PRINCIPAL${suffix} (the legacy name is removed in v3.0.0)\n`,
    );
    return legacyCortex;
  }

  // Pre-cortex tier. No warning here: the GROVE_* → CORTEX_* namespace
  // rename is a separate migration with its own deprecation window.
  return env[`GROVE_OPERATOR${suffix}`];
}
