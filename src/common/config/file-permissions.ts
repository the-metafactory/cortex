/**
 * Shared filesystem-permission helpers.
 *
 * Extracted in cortex#87 (Echo round-1 finding: the chmod-600 gate was
 * being duplicated across `account-signing-key.ts` and the new
 * NatsLink creds path). Consolidating here means future policy changes
 * — loosening to allow `0o400`, tightening to also reject group-owned,
 * Windows ACL probing instead of skip — happen in one place and ripple
 * to every consumer.
 *
 * Callers:
 *   - `account-signing-key.ts` (operator account signing key, SA-prefix)
 *   - `bus/nats/connection.ts` (NATS user `.creds`, JWT + NKey seed)
 */

import { statSync } from "fs";

/** POSIX permission bits — file `mode & this` strips the file-type bits. */
const POSIX_MODE_MASK = 0o777;

/** Owner-only read/write. The only mode we accept for sensitive secrets. */
const REQUIRED_MODE = 0o600;

/**
 * Assert that a file is `chmod 600` on POSIX (owner-only read/write).
 *
 * Throws a principal-readable error when the mode is anything else,
 * including modes that are nominally tighter (e.g. `0o400`) — the
 * daemon expects to be able to read AND write its own secrets, and a
 * `0o400` file usually means the principal ran `chmod a-w` by hand and
 * we'd prefer the loud failure to a silent partial enforcement.
 *
 * On Windows the gate is skipped with a stderr note. NTFS uses ACLs,
 * not POSIX mode bits, so `stat.mode` there is meaningless. Principals
 * on Windows are responsible for managing ACLs out of band.
 *
 * Propagates `ENOENT` / `EACCES` from `statSync` — callers can let
 * those bubble up unchanged; the path is already in the error.
 *
 * @param path Absolute or process-relative path to check. Tilde-expansion
 *   is the caller's responsibility (use `expandTilde` in `loader.ts`).
 */
export function enforceChmod600(path: string): void {
  if (process.platform === "win32") {
    // Best-effort note so the principal knows the gate didn't fire.
    // No logger threaded in here (this module stays dependency-free).
    process.stderr.write(
      `[file-permissions] chmod 600 gate skipped on win32 — NTFS ACLs are the principal's responsibility (${path})\n`,
    );
    return;
  }
  // Sync `statSync` keeps the check tight (one syscall) and avoids
  // widening the TOCTOU window beyond what the caller's subsequent read
  // already implies.
  const stat = statSync(path); // throws ENOENT if missing
  const mode = stat.mode & POSIX_MODE_MASK;
  if (mode !== REQUIRED_MODE) {
    throw new Error(
      `${path} must be chmod 600, found ${mode.toString(8).padStart(3, "0")}`,
    );
  }
}
