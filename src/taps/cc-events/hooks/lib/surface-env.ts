/**
 * G-2a/G-3a (cortex#774) — surface instrumentation env-var resolver. The
 * `GROVE_*` → `CORTEX_*` namespace migration renames the EventLogger
 * instrumentation env vars (channel / network / agent-name / agent-id /
 * project / entity) to the `CORTEX_*` prefix.
 *
 * NON-BREAKING transition: readers prefer `CORTEX_{field}` and retain a
 * read-fallback to the legacy `GROVE_{field}` name so any external setter
 * still on `GROVE_*` keeps resolving during the cutover. The fallback is
 * removed only once MIG-8 is confirmed closed and external setters are
 * audited (deferred to a future PR).
 *
 * NOTE: the `principal`-the-human field is NOT handled here — it has its own
 * resolver (`principal-env.ts`) with a different chain
 * (`CORTEX_PRINCIPAL` → `GROVE_OPERATOR`).
 */

/** Instrumentation field suffixes carried by both the CORTEX_* and GROVE_* names. */
export type SurfaceField =
  | "CHANNEL"
  | "NETWORK"
  | "AGENT_NAME"
  | "AGENT_ID"
  | "PROJECT"
  | "ENTITY";

/**
 * Resolve a surface instrumentation env var.
 *
 * Lookup order (first defined wins):
 *   1. `CORTEX_{field}` — the canonical name.
 *   2. `GROVE_{field}`  — retained read-fallback for the transition window.
 *
 * @param field the instrumentation field, e.g. `"CHANNEL"` for
 *   `CORTEX_CHANNEL` / `GROVE_CHANNEL`.
 * @param env the environment to read; defaults to `process.env`. Injectable
 *   for tests.
 * @returns the resolved value, or `undefined` when neither tier is set.
 */
export function resolveSurfaceEnv(
  field: SurfaceField,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const canonical = env[`CORTEX_${field}`];
  if (canonical !== undefined) return canonical;

  // Pre-cortex tier. No warning here: the GROVE_* → CORTEX_* namespace
  // rename is a transition with its own deprecation window (cortex#774).
  return env[`GROVE_${field}`];
}
