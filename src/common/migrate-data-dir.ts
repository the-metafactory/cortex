/**
 * XDG wave-5 (cortex#1902, EPIC cortex#1867 §P3b) — DATA migration-on-touch.
 *
 * The data move is COPY-KEEP-SOURCE (never move a db out from under a running
 * process): when a canonical data path is about to be TOUCHED but only a legacy
 * copy exists, the legacy copy is carried to the canonical location and the
 * SOURCE is KEPT. Existence-gated resolution (`data-path.ts`) then prefers the
 * canonical copy; a pre-cutover box that never ran the migration still reads the
 * legacy tree. Nothing here ever deletes a source — a mid-flight crash leaves
 * the legacy tree fully intact and the move simply re-runs (idempotent).
 *
 * ── Live-DB safety (the WAL hazard) ─────────────────────────────────────────
 * A SQLite db in WAL mode keeps committed frames in a `-wal` sidecar until a
 * checkpoint folds them into the main `.db` file. Copying ONLY the `.db` file
 * would therefore drop the most recent committed transactions. So a db carry:
 *   1. best-effort `PRAGMA wal_checkpoint(TRUNCATE)` on the legacy db (folds the
 *      WAL into the main file; a partial checkpoint under active readers is
 *      tolerated — the `-wal` is still carried below), then
 *   2. atomically copies the main `.db` file, AND
 *   3. carries any `-wal` / `-shm` sidecars that still exist, so a partial
 *      checkpoint's committed frames travel WITH the db (a consistent snapshot).
 * The source is only ever READ + checkpointed, never renamed or removed.
 *
 * This is the DATA analogue of `config/migrate-config-dir.ts` and reuses its
 * `atomicWriteFile` primitive (create-temp-O_EXCL → write → fsync → chmod →
 * rename). Isolation: every path derives from an injectable `home`.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname } from "path";

import { atomicWriteFile } from "./config/migrate-config-dir";
import {
  canonicalCursorPath,
  canonicalStackDbPath,
  canonicalStandaloneDbPath,
  cortexDataDirOverride,
  legacyCursorPath,
  legacyStackDbPath,
  legacyStandaloneDbPath,
} from "./data-path";

/** The WAL/SHM sidecar suffixes carried alongside a `.db` file. */
const DB_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/** Outcome of a migration-on-touch attempt. */
export interface DataMigrationResult {
  /** The path callers should now use (canonical when migrated or pre-existing). */
  path: string;
  /** True when THIS call performed the copy (false = already-canonical / nothing to carry). */
  migrated: boolean;
}

/**
 * Best-effort WAL checkpoint on a legacy db so its committed frames fold into
 * the main `.db` file before the copy. Opens read-write (a checkpoint is a
 * write), TRUNCATEs the WAL, and closes. NEVER throws — a locked / read-only /
 * corrupt legacy db just means we skip the checkpoint and carry the sidecars
 * as-is (the `-wal` copy below preserves any un-folded committed frames).
 */
function checkpointLegacyDb(legacyDbPath: string): void {
  let db: Database | undefined;
  try {
    db = new Database(legacyDbPath); // read-write — a checkpoint writes
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Locked by a live process, read-only fs, or not-yet-WAL — tolerated.
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close
    }
  }
}

/**
 * Atomically copy one file `src` → `dest`, preserving mode, keeping the source.
 * Idempotent at the call site (callers gate on `existsSync(dest)`); the write
 * itself is atomic (temp-O_EXCL → fsync → rename) so a crash never leaves a torn
 * destination.
 */
function atomicCopyKeepingSource(src: string, dest: string): void {
  const mode = statSync(src).mode & 0o777;
  const data = readFileSync(src); // SOURCE is only ever READ, never renamed
  atomicWriteFile(dest, data, mode);
}

/**
 * Migrate-on-touch a SQLite db (with WAL/SHM sidecars), copy-keep-source.
 *
 * Idempotent + non-destructive:
 *   - canonical db already present → no-op, returns `{migrated:false}` (canonical
 *     is authoritative; never clobber it with a stale legacy copy);
 *   - only a legacy db present → checkpoint it, then atomically carry the main
 *     `.db` file + any `-wal`/`-shm` sidecars to canonical (source kept),
 *     returns `{migrated:true}`;
 *   - neither present → no-op, returns `{migrated:false}` (canonical is the
 *     write target a fresh install will create).
 *
 * An explicit `$CORTEX_DATA_DIR` root has no legacy counterpart — never reach
 * into the real `~/.local/share/{cortex,grove}` (breaks the hermetic guard).
 */
export function migrateDbOnTouch(canonicalDbPath: string, legacyDbPath: string): DataMigrationResult {
  if (existsSync(canonicalDbPath)) return { path: canonicalDbPath, migrated: false };
  if (cortexDataDirOverride() !== undefined) return { path: canonicalDbPath, migrated: false };
  if (!existsSync(legacyDbPath)) return { path: canonicalDbPath, migrated: false };

  // Fold the WAL into the main file first (best-effort), then copy consistently.
  checkpointLegacyDb(legacyDbPath);
  mkdirSync(dirname(canonicalDbPath), { recursive: true });
  atomicCopyKeepingSource(legacyDbPath, canonicalDbPath);
  // Carry any surviving sidecars so a partial checkpoint's committed frames
  // travel with the db. `-shm` is regenerable but harmless to carry; `-wal`
  // may hold committed frames not yet folded — carrying it is the safe choice.
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const srcSidecar = `${legacyDbPath}${suffix}`;
    if (existsSync(srcSidecar)) {
      atomicCopyKeepingSource(srcSidecar, `${canonicalDbPath}${suffix}`);
    }
  }
  return { path: canonicalDbPath, migrated: true };
}

/**
 * Migrate-on-touch a plain data file (e.g. the MC hook cursor), copy-keep-source.
 * Idempotent + non-destructive, same gating as {@link migrateDbOnTouch} minus
 * the WAL handling.
 */
export function migrateDataFileOnTouch(canonicalPath: string, legacyPath: string): DataMigrationResult {
  if (existsSync(canonicalPath)) return { path: canonicalPath, migrated: false };
  if (cortexDataDirOverride() !== undefined) return { path: canonicalPath, migrated: false };
  if (!existsSync(legacyPath)) return { path: canonicalPath, migrated: false };
  mkdirSync(dirname(canonicalPath), { recursive: true });
  // copyFileSync would apply the umask, not the source mode — use the atomic
  // copy which re-asserts the source mode (a 0600 cursor stays 0600).
  atomicCopyKeepingSource(legacyPath, canonicalPath);
  return { path: canonicalPath, migrated: true };
}

// ─────────────────────────────────────────────── stack / standalone / cursor wrappers

/**
 * Resolve-and-migrate the SERVING stack's OWN per-stack MC db: carry a legacy
 * `~/.local/share/cortex/mc/<stack>/…` db to the canonical metafactory tree
 * (copy-keep-source, WAL-safe) and return the canonical path. Call at boot
 * BEFORE opening the db. The sibling reader does NOT call this — it only reads
 * peers' dbs (pure resolution, never migrates another stack's data).
 */
export function migrateStackDbOnTouch(stack: string, home?: string): string {
  return migrateDbOnTouch(canonicalStackDbPath(stack, home), legacyStackDbPath(stack, home)).path;
}

/** Resolve-and-migrate the standalone MC v2 db (legacy grove → canonical). */
export function migrateStandaloneDbOnTouch(home?: string): string {
  return migrateDbOnTouch(canonicalStandaloneDbPath(home), legacyStandaloneDbPath(home)).path;
}

/** Resolve-and-migrate the MC hook cursor (G-25: legacy grove → canonical). */
export function migrateCursorOnTouch(home?: string): string {
  return migrateDataFileOnTouch(canonicalCursorPath(home), legacyCursorPath(home)).path;
}
