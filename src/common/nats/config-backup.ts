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
 * SAME timestamped, same-directory, permission-preserving recovery artefact —
 * independent of, and in addition to, any in-memory rollback.
 */

import { chmodSync, copyFileSync, existsSync, statSync } from "fs";

/**
 * Write a timestamped `.bak-<label>-<epochMillis>` sidecar of `path` BEFORE a
 * config mutation. No-op (returns `undefined`) when `path` does not exist yet
 * — nothing to back up (a fresh file has no prior state to protect). Mirrors
 * the file's own permission bits onto the backup (relevant for a 0600
 * secret-bearing config) — a best-effort mirror; a failure to chmod the backup
 * is logged but never blocks the backup itself (the backup's CONTENT, already
 * copied, is what matters for recovery).
 */
export function backupConfigFile(path: string, label: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backupPath = `${path}.bak-${label}-${Date.now().toString()}`;
  copyFileSync(path, backupPath);
  try {
    const mode = statSync(path).mode;
    chmodSync(backupPath, mode & 0o777);
  } catch (err) {
    // Best-effort permission mirror — the backup's content is already safe on
    // disk; a chmod failure here must never abort the caller's write.
    process.stderr.write(
      `config-backup: could not mirror permissions onto ${backupPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return backupPath;
}
