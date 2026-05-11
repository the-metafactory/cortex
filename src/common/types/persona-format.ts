/**
 * F-1 — Persona format version constant.
 *
 * Bot packages declare a supported range via `runtime.persona-format: ^1.0`
 * in their `arc-manifest.yaml`. Cortex compares the bot's declared range
 * against this constant at install time (see `CortexHostAdapter.detect()`
 * — F-5) and rejects the install if the range is not satisfied.
 *
 * Schema reference, examples, and versioning policy: `docs/persona-format.md`.
 *
 * Bump rules (see `docs/persona-format.md` §Versioning):
 *   - Add optional field → minor bump
 *   - Add required field → major bump
 *   - Default value change → minor
 *   - Type/validation tightening → major
 *   - Type/validation loosening → minor
 *
 * When bumping, update three places in lock-step:
 *   1. This constant
 *   2. `docs/persona-format.md` §Current version + §Versioning changelog
 *   3. The unit test asserting the exact value
 */
export const PERSONA_FORMAT_VERSION = "1.0.0" as const;
