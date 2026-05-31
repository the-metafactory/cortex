/**
 * Letter-prefix kebab id regex — shared validator for the
 * lowercase-alphanumeric-plus-hyphen, letter-prefixed naming
 * convention cortex uses across many identifier kinds.
 *
 * Why centralised: pre-cortex#150 the same regex
 * (`/^[a-z][a-z0-9-]*$/`) appeared in 15 callsites across
 * `cortex-config.ts` (12 sites), `capability.ts`, and
 * `runner/dispatch-listener.ts`. Drift between independent
 * copies was a real risk — particularly the letter-prefix
 * trilogy (cortex#141 / #144 / #145) which tightened the
 * grammar after the schemas already existed; any new
 * identifier kind added by hand would silently lack that
 * tightening unless the author remembered.
 *
 * The 17th and 18th original callsites at
 * `src/services/network-registry/` are NOT migrated — that
 * service is a separate Cloudflare Worker build with its own
 * tsconfig; importing from cortex source would couple the
 * builds. The two local consts there match by-eye review.
 *
 * Closes cortex#150.
 */

/**
 * Canonical letter-prefix kebab id regex.
 *
 * Format: lowercase letter, then any number of lowercase
 * alphanumeric or hyphen chars. The leading-letter rule
 * (cortex#141 trilogy) prevents NATS subject matchers from
 * mistaking a leading-digit id for a numeric segment in
 * production routing.
 *
 * Used for: agent id, principal id, network id, role id,
 * principal id, peer principal id, capability id, federation
 * network id, and the dispatch-listener's runtime network
 * id check.
 */
export const LETTER_PREFIX_ID_REGEX = /^[a-z][a-z0-9-]*$/;
