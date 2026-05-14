/**
 * C-108 (Prereq B for cortex#67): operator account signing key loader.
 *
 * The operator's account signing key (NATS "SA"-prefixed nkey seed) is what
 * mints per-agent NATS user JWTs (cortex#58 D7 + §6.3, design-arc-agent-bots).
 * It is the most sensitive key material the cortex daemon holds — it never
 * leaves daemon memory, is never logged, and is never persisted to disk by
 * cortex itself.
 *
 * Threat model (one paragraph): a leaked account signing key lets an attacker
 * mint user JWTs for any agent in the operator's account, bypassing every
 * cortex-side authorization check. Since the key sits on the operator's
 * laptop / server filesystem, the next-best mitigation is to refuse to load
 * it unless the file is chmod 600 (owner-only read/write). This loader
 * enforces that gate; the schema field (`nats.accountSigningKeyPath`) is
 * MIRRORed across `BotConfigSchema.nats` + `NatsConfigSchema` so both the
 * legacy bot.yaml shape and the post-MIG-7.2e cortex-config shape carry it.
 *
 * Behavior:
 *   - `fs.statSync(path).mode & 0o777` MUST equal `0o600` (POSIX). On
 *     Windows, the chmod gate is logged and skipped — NTFS uses ACLs
 *     instead, and the macOS/Linux mode bits we read there are always
 *     `0o666`. The expectation is that operators on Windows manage ACLs
 *     out-of-band; supporting Windows is a soft goal here, not a target
 *     platform for the daemon.
 *   - The seed file is read, trimmed of whitespace (operators tend to
 *     leave a trailing newline), and parsed via `nkeys.fromSeed`.
 *   - The parsed seed MUST be account-prefixed ("SA..."). Operator
 *     signing keys ("SO...") and user signing keys ("SU...") are
 *     rejected — the design wants the operator's *account* signing key,
 *     not the operator root key, because account-level signing is what
 *     scopes minted JWTs to the operator's account.
 *
 * NOT covered here (deferred to C-067 itself):
 *   - In-memory zeroization after use. The KeyPair is held for the
 *     daemon lifetime; we revisit when we add credential rotation.
 *   - Hardware-backed signing (yubikey / TPM). Future work; the
 *     `loadAccountSigningKey` signature is the seam.
 *
 * MIRROR: schema field carried in both `BotConfigSchema.nats` + the
 * canonical `NatsConfigSchema`. Drop legacy on MIG-7.2e.
 */

import { promises as fsp } from "fs";
import { fromSeed, type KeyPair } from "nkeys.js";
import { enforceChmod600 } from "./file-permissions";

/**
 * Account signing key seed prefix. NATS nkey seeds for an *account* always
 * start with `SA` (Seed + Account prefix bytes, base32-encoded). Operator
 * seeds are `SO`, user seeds are `SU`, server seeds are `SN`, etc. We want
 * the account one specifically — see file header.
 */
const ACCOUNT_SEED_PREFIX = "SA";

/**
 * Load + validate the operator's account signing nkey from disk.
 *
 * Throws (with a clear, operator-facing message) on:
 *   - File missing / unreadable (propagates ENOENT / EACCES).
 *   - chmod not exactly `0600` on POSIX (no group / world access).
 *   - Seed not prefixed `SA` (i.e. not an account seed).
 *   - Seed bytes that `nkeys.fromSeed` rejects as malformed.
 *
 * @param path Absolute or process-relative path to the seed file.
 * @returns A KeyPair ready for `sign(input)` calls.
 */
export async function loadAccountSigningKey(path: string): Promise<KeyPair> {
  // 1. Permission gate. Delegated to the shared `enforceChmod600` helper
  //    (extracted in cortex#87 — same policy now backs the NATS creds
  //    loader, so policy changes ripple to both consumers in one place).
  enforceChmod600(path);

  // 2. Read + trim. Operators routinely leave a trailing newline after
  //    `nsc generate nkey -a > account.nk`; `fromSeed` would reject the
  //    raw bytes if we passed them as-is.
  const raw = await fsp.readFile(path, "utf-8");
  const seed = raw.trim();

  // 3. Prefix gate. `nkeys.fromSeed` will accept anything that decodes
  //    cleanly, including operator/user/server seeds — so we have to
  //    enforce the SA prefix ourselves. Reject early with a clear error
  //    that tells the operator which kind of key they handed us.
  if (!seed.startsWith(ACCOUNT_SEED_PREFIX)) {
    const actualPrefix = seed.slice(0, 2);
    throw new Error(
      `expected account signing key (prefix ${ACCOUNT_SEED_PREFIX}...), got ${actualPrefix}... at ${path}`,
    );
  }

  // 4. Parse. `fromSeed` expects Uint8Array; we encode the trimmed string
  //    via TextEncoder (UTF-8 is identical to ASCII for the base32
  //    alphabet nkey seeds live in).
  const seedBytes = new TextEncoder().encode(seed);
  try {
    return fromSeed(seedBytes);
  } catch (err) {
    // Re-throw with the path attached so operators can pinpoint the
    // bad file when they have multiple nkey files staged.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse account signing key at ${path}: ${message}`, { cause: err });
  }
}
