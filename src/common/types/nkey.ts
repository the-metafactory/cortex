/**
 * NKey public-key regex — shared validator for the 56-char
 * U-prefixed base32 form used across cortex.yaml configs.
 *
 * Why centralised: pre-cortex#143 the same regex
 * (`/^U[A-Z2-7]{55}$/`) appeared in 6 callsites across
 * `cortex-config.ts`, `config.ts`, and `stack.ts`. Drift between
 * those was a real risk — if any single site loosened (e.g. to
 * accept lowercase) the schema would silently admit a malformed
 * NKey at that surface only. One source of truth, one regex.
 *
 * Format: `U` + 55 chars from the NATS NKey base32 alphabet
 * (`A-Z` + `2-7`). Total 56 chars. The `U` prefix designates a
 * user-account public key in the NATS NKey scheme; cortex uses
 * these for stack-signing identity (Phase B).
 *
 * Cross-references:
 *   - `src/common/types/cortex-config.ts` — PolicyPrincipalSchema,
 *     PolicyFederatedPeerSchema, PolicyFederatedNetworkSchema.peers.
 *   - `src/common/types/stack.ts` — StackConfigSchema.nkey_pub.
 *   - `src/common/types/config.ts` — legacy AgentConfig nkey field.
 *
 * Closes cortex#143.
 */

/**
 * Canonical NKey public-key validator regex.
 *
 * `U[A-Z2-7]{55}` — U-prefixed, 55 base32-alphabet chars.
 */
export const NKEY_PUBKEY_REGEX = /^U[A-Z2-7]{55}$/;

/**
 * Human-friendly error message Zod (or any other validator)
 * surfaces when a value fails {@link NKEY_PUBKEY_REGEX}. Includes
 * the full grammar + length so principals editing cortex.yaml get
 * the exact contract from the error.
 */
export const NKEY_PUBKEY_ERROR_MESSAGE =
  "must be a base32 NKey public key (U-prefixed, 56 chars total)";
