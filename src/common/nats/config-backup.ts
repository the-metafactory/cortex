/**
 * cortex#1483 (join-4, epic #1479) — the shared `.bak` sidecar helper for a
 * live nats-server config mutation.
 *
 * A hand-edit or a bad canary render can take a live, often public-facing,
 * operator-mode bus down. `join`'s leaf-state snapshot/restore (#821) already
 * gives an IN-PROCESS rollback path, and `make-live` already writes
 * `.bak-makelive-<ts>` sidecars for its own resolver/creds writes — but those
 * two mechanisms don't cover every config-mutating write, and an in-process
 * snapshot does not survive the process exiting. {@link backupConfigFile} is
 * the ONE shared helper so every config write this slice touches gets the
 * SAME timestamped, same-directory recovery artefact — independent of, and in
 * addition to, any in-memory rollback.
 *
 * cortex#1495 important 2 — the backup carries SECRET-bearing config (leaf
 * creds, hub authorization users, payload keys). It is created 0600 from the
 * first byte (write with `mode: 0o600` + an explicit chmod against a permissive
 * umask), NOT `copyFileSync`-then-`chmod` (which would leave a world-readable
 * window while the file inherits the default create mode before the narrowing
 * chmod). The backup is never more permissive than the secret it protects.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";

/**
 * cortex#1495 nit 3 — a monotonic per-process counter so two backups taken in
 * the SAME millisecond never collide on the same filename (the pre-fix
 * `Date.now()`-only name could). Combined with the pid it is unique across
 * concurrent processes too.
 */
let backupSeq = 0;

/**
 * Write a timestamped `.bak-<label>-<epochMillis>-<pid>-<seq>` sidecar of `path`
 * BEFORE a config mutation, created 0600 (secret-safe). No-op (returns
 * `undefined`) when `path` does not exist yet — nothing to back up (a fresh file
 * has no prior state to protect). NEVER throws: the caller's write must proceed
 * even if the backup itself failed (a failure is logged and surfaced by the
 * `undefined` return).
 */
export function backupConfigFile(path: string, label: string): string | undefined {
  if (!existsSync(path)) return undefined;
  // Unique even for same-millisecond / concurrent-process writes (nit 3).
  const suffix = `${Date.now().toString()}-${process.pid.toString()}-${(backupSeq++).toString()}`;
  const backupPath = `${path}.bak-${label}-${suffix}`;
  try {
    // important 2 — create the backup 0600 ATOMICALLY with the write (never
    // copy-then-chmod). `writeFileSync`'s create mode is masked by the umask, so
    // chmod back to 0600 to be robust against a permissive umask (mirrors the
    // leaf-include 0600 discipline in network-adapters.ts).
    const data = readFileSync(path);
    writeFileSync(backupPath, data, { mode: 0o600 });
    chmodSync(backupPath, 0o600);
  } catch (err) {
    // Best-effort — the caller's config write must proceed even if the backup
    // failed. Surface it so the caller knows the recovery artefact is missing.
    process.stderr.write(
      `config-backup: could not write backup ${backupPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
  return backupPath;
}
