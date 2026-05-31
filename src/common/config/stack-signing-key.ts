/**
 * IAW Phase B.3 (cortex#114) — stack signing key loader.
 *
 * The stack's signing key (NATS `SU`-prefixed nkey seed — user-class
 * key) is what cortex uses to sign outbound `dispatch.task.*` and
 * other peer-visible envelopes via myelin's `signEnvelope`. The
 * matching public key (`U` + 55 base32) is declared on
 * `cortex.yaml.stack.nkey_pub`; this loader is the seed side.
 *
 * Threat model: a leaked stack seed lets an attacker mint signed
 * envelopes that look like they came from this stack — every peer on
 * the bus that trusts this stack's public key would accept the
 * forgery. Less catastrophic than the operator account signing key
 * (which mints USER JWTs), but still load-bearing for the
 * `signed_by[]` chain's integrity. The chmod 600 gate is the same
 * mitigation pattern as `account-signing-key.ts`; the prefix gate
 * rejects seeds that don't match the user-class (`SU`) we expect.
 *
 * Mirrors `src/common/config/account-signing-key.ts` deliberately —
 * different prefix (`SU` vs `SA`), different threat scope, identical
 * loading discipline.
 *
 * NOT covered here (forward work):
 *   - In-memory zeroization. The KeyPair lives for the daemon
 *     lifetime; revisit when credential rotation lands.
 *   - Hardware-backed signing (yubikey / TPM). Future work; this
 *     function's signature is the seam — a `loadStackSigningKey`
 *     replacement could return a KeyPair-shaped facade that delegates
 *     to a hardware backend without changing call sites.
 *
 * Cross-references:
 *   - cortex#114 — IAW Phase B umbrella
 *   - cortex#200 (B.1c) — myelin `signEnvelope` consumer pattern
 *   - cortex#102 — design: bot↔bot via bus envelopes (NKey identity)
 *   - `src/bus/myelin/runtime.ts` — call site that consumes the loaded
 *     keypair to sign outbound envelopes
 */

import { promises as fsp } from "fs";
import { fromSeed, type KeyPair } from "nkeys.js";
import { enforceChmod600 } from "./file-permissions";

/**
 * Stack signing key seed prefix. NATS nkey seeds for a *user* always
 * start with `SU` (Seed + User prefix bytes, base32-encoded). The
 * stack's public key (`U...`) is the user-class pair, so the seed
 * matches.
 */
const STACK_SEED_PREFIX = "SU";

/**
 * Load + validate the stack signing nkey from disk.
 *
 * Throws (with a clear, principal-facing message) on:
 *   - File missing / unreadable (propagates ENOENT / EACCES).
 *   - chmod not exactly `0600` on POSIX (no group / world access).
 *   - Seed not prefixed `SU` (i.e. not a user-class seed).
 *   - Seed bytes that `nkeys.fromSeed` rejects as malformed.
 *
 * @param path Absolute or process-relative path to the seed file.
 * @returns A KeyPair ready for `sign(input)` calls + `getPublicKey()`
 *          inspection. Production call sites pair this with
 *          `cortex.yaml.stack.nkey_pub` and assert the two agree —
 *          a mismatch indicates the seed file points at a different
 *          identity than the declared public key.
 */
export async function loadStackSigningKey(path: string): Promise<KeyPair> {
  // 1. Permission gate. Shared helper backs both account-signing-key
  //    and this loader — policy changes ripple to both consumers.
  enforceChmod600(path);

  // 2. Read + trim. `nsc generate nkey -u > stack.nk` leaves a
  //    trailing newline that `fromSeed` would reject as malformed.
  const raw = await fsp.readFile(path, "utf-8");
  const seed = raw.trim();

  // 3. Prefix gate. Reject early with a clear error that tells the
  //    principal which kind of key they handed us. Operator account
  //    keys (`SA`), operator root keys (`SO`), server keys (`SN`),
  //    and curve keys (`SC`) all fail this check.
  if (!seed.startsWith(STACK_SEED_PREFIX)) {
    const actualPrefix = seed.slice(0, 2);
    throw new Error(
      `expected stack signing key (prefix ${STACK_SEED_PREFIX}...), got ${actualPrefix}... at ${path}`,
    );
  }

  // 4. Parse. `fromSeed` expects Uint8Array; the trimmed string is
  //    pure ASCII (NKey base32 alphabet) so UTF-8 encoding is
  //    byte-identical.
  const seedBytes = new TextEncoder().encode(seed);
  try {
    return fromSeed(seedBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse stack signing key at ${path}: ${message}`, { cause: err });
  }
}
