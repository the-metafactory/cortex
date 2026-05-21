/**
 * R9 (cortex#388) — principal env-var resolver. The vocabulary migration
 * renamed the `operator`-the-human concept to `principal`; on the env
 * surface that means `CORTEX_PRINCIPAL_*` is the canonical name.
 *
 * v3.0.0 BREAKING (manifest PR-11) — the `CORTEX_OPERATOR_*` compat
 * fallback that the v2.x transition release accepted on read is REMOVED.
 * Operators running `CORTEX_OPERATOR*` env vars rename them to
 * `CORTEX_PRINCIPAL*` before installing v3.
 *
 * The deepest tier (`GROVE_OPERATOR`) stays as the last-resort fallback
 * — its removal is owned by the separate `GROVE_*` → `CORTEX_*`
 * namespace migration (postinstall.sh notes; retires at MIG-8).
 */

/**
 * Resolve a `*_PRINCIPAL`-suffixed env var.
 *
 * Lookup order (first defined wins):
 *   1. `CORTEX_PRINCIPAL{suffix}` — the canonical name.
 *   2. `GROVE_OPERATOR{suffix}`   — pre-cortex name; owned by the separate
 *      `GROVE_*` → `CORTEX_*` namespace migration.
 *
 * @param suffix the variable suffix after the `CORTEX_PRINCIPAL` /
 *   `GROVE_OPERATOR` stem, e.g. `""` for the bare name or `"_ID"` for
 *   `CORTEX_PRINCIPAL_ID`.
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

  // Pre-cortex tier. No warning here: the GROVE_* → CORTEX_* namespace
  // rename is a separate migration with its own deprecation window.
  return env[`GROVE_OPERATOR${suffix}`];
}
