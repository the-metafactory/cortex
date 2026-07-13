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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { dirname, join } from "path";

import { atomicWriteFile } from "./config/migrate-config-dir";
import {
  canonicalPublishedEventsDir,
  canonicalStackDbPath,
  cortexDataDirOverride,
  legacyPublishedEventsDir,
  legacyStackDbPath,
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
 * Carry any surviving `-wal` / `-shm` sidecars from `legacyDbPath` to sit
 * alongside `canonicalDbPath`, copy-keep-source. Separated from
 * {@link migrateDbOnTouch} so the carry can be exercised DIRECTLY (with real
 * sidecar files present and NO intervening db-open) — a db-open would let
 * SQLite unlink a stray `-wal` on some platforms (Linux), making an in-migrator
 * "the sidecar survives an open" assertion non-deterministic. This helper states
 * the real invariant: given sidecars on disk at copy time, they travel WITH the
 * db. Returns the number of sidecars copied (0 when none exist — a no-op that
 * never throws).
 */
export function carryDbSidecars(canonicalDbPath: string, legacyDbPath: string): number {
  let carried = 0;
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    const srcSidecar = `${legacyDbPath}${suffix}`;
    if (existsSync(srcSidecar)) {
      atomicCopyKeepingSource(srcSidecar, `${canonicalDbPath}${suffix}`);
      carried += 1;
    }
  }
  return carried;
}

/**
 * Whether the db at `dbPath` is a VALID, self-consistent SQLite db. Opens
 * read-only and runs `PRAGMA integrity_check`; a checkpointed db needs no `-wal`
 * to be valid, so this is the invariant that actually matters after a carry.
 * NEVER throws — an unreadable / not-a-db / corrupt file reads as invalid.
 */
function canonicalDbIsValid(dbPath: string): boolean {
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | null;
    return row?.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // best-effort close
    }
  }
}

/** Remove a canonical db copy + its sidecars (best-effort). The SOURCE is KEPT. */
function removeCanonicalDbCopy(canonicalDbPath: string): void {
  for (const p of [canonicalDbPath, ...DB_SIDECAR_SUFFIXES.map((s) => `${canonicalDbPath}${s}`)]) {
    try {
      if (existsSync(p)) rmSync(p);
    } catch {
      // best-effort — a leftover here just means the next run re-attempts.
    }
  }
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
  carryDbSidecars(canonicalDbPath, legacyDbPath);

  // Torn-copy hardening: idempotence gates on `existsSync(canonical)`, so a
  // half-copied / corrupt canonical db would be stickily preferred FOREVER
  // (`resolveStackDbPath` picks it, MC opens garbage). Validate the copy with
  // `PRAGMA integrity_check`; on failure remove the canonical copy + sidecars
  // (the SOURCE is KEPT → no data loss) so the NEXT boot re-attempts the carry.
  if (!canonicalDbIsValid(canonicalDbPath)) {
    removeCanonicalDbCopy(canonicalDbPath);
    return { path: canonicalDbPath, migrated: false };
  }
  return { path: canonicalDbPath, migrated: true };
}

// ───────────────────────────────────────────────────────── stack MC db wrapper

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

// ── Why there is no standalone-db / cursor migrator (GAP-1 / GAP-2, #1902) ────
//
// The STANDALONE MC v2 db (`~/.local/share/grove/mission-control.db`, layout 1)
// and the STANDALONE grove hook cursor (`~/.local/share/grove/mc-hook-cursor.json`,
// G-25) are read ONLY by the retired standalone entry `surface/mc/index.ts`,
// which is RETIRED FOR PRODUCTION (FS-8a, #1822): it refuses to boot without the
// `--legacy` / `MC_LEGACY_BOOT` test-harness escape hatch. The PRODUCTION MC runs
// EMBEDDED (`surface/mc/embed.ts`), which resolves its db via `migrateStackDbOnTouch`
// (above) and OVERRIDES the cursor to sit BESIDE that per-stack db
// (`embed.ts` → `join(dirname(dbPath), "mc-hook-cursor.json")`) — it never touches
// the grove standalone db OR cursor. So a `migrate{Standalone,Cursor}OnTouch`
// would have NO production writer to guard: wiring it into the retired boot path
// is theater, and leaving it unwired is a dead migrator. Both were removed.
// The existence-gated *resolvers* (`resolveStandaloneDbPath` / `resolveCursorPath`
// in `data-path.ts`) stay — they let the retired harness boot still read a legacy
// grove file in place — but no COPY-forward runs for a path nothing writes.

/**
 * Carry the in-flight PUBLISHED-events buffer to the canonical data-root
 * location (XDG wave-5 #1902, guardrail A), copy-keep-source. Any event already
 * published-but-not-yet-consumed sits in the legacy `~/.claude/events/published`
 * dir; the buffer move must COPY those files forward (not just repoint) so a
 * consumer now reading the canonical dir doesn't miss them. RAW stays at
 * `~/.claude/events/raw` (hook-substrate boundary) — only the published archive
 * moves.
 *
 * Idempotent + non-destructive: each legacy file whose canonical counterpart is
 * ABSENT is atomically copied (source mode preserved); an already-carried file
 * is skipped (canonical-wins); the legacy files are KEPT. Returns the canonical
 * published dir (the location the relay writes and the consumer reads).
 *
 * An explicit `$CORTEX_DATA_DIR` root has no legacy counterpart — never reach
 * into the real `~/.claude/events/published` (breaks the hermetic guard).
 *
 * @returns `{ dir, carried }` — the canonical dir and how many files THIS call copied.
 */
export function migratePublishedBufferOnTouch(home?: string): { dir: string; carried: number } {
  const canonical = canonicalPublishedEventsDir(home);
  if (cortexDataDirOverride() !== undefined) return { dir: canonical, carried: 0 };

  const legacy = legacyPublishedEventsDir(home);
  if (!existsSync(legacy)) return { dir: canonical, carried: 0 };

  let entries: string[];
  try {
    entries = readdirSync(legacy);
  } catch {
    return { dir: canonical, carried: 0 };
  }

  let carried = 0;
  for (const name of entries) {
    const src = join(legacy, name);
    let st;
    try {
      st = statSync(src);
    } catch {
      continue; // vanished between readdir + stat — skip
    }
    if (!st.isFile()) continue; // buffer holds flat JSONL(.gz) files; skip any nested dir
    const dest = join(canonical, name);
    if (existsSync(dest)) continue; // canonical-wins — never clobber an already-carried file
    atomicCopyKeepingSource(src, dest);
    carried += 1;
  }
  return { dir: canonical, carried };
}
