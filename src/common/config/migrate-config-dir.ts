/**
 * XDG wave-4 (cortex#1869, EPIC cortex#1867 §P3a) — config DIRECTORY migrator.
 *
 * Moves the cortex config tree from the two pre-move locations
 * (`~/.config/cortex`, `~/.config/grove`) into the canonical
 * `~/.config/metafactory/cortex`. This is the DATA-SAFETY core of the wave; the
 * resolver (`config-path.ts`) only decides which tree a read lands in.
 *
 * ── Merge policy (G-42) ──────────────────────────────────────────────────────
 * BOTH legacy trees may be live with divergent content (grove-only: `bot.yaml`,
 * `dashboard.db`; cortex-only: per-stack dirs, a different `personas/`). We
 * therefore enumerate the UNION of both trees and apply per-path precedence:
 *   - a path present in the flat cortex tree wins over the grove copy
 *     (cortex-wins-on-dup); the shadowed grove copy is recorded, never deleted;
 *   - a grove-ONLY path is CARRIED (never lost — a grove-only secret must
 *     survive the move);
 *   - `.bak` sidecars and `personas/` are ordinary files under the tree and are
 *     carried like any other config file.
 *
 * ── Config-only scope ────────────────────────────────────────────────────────
 * State/data-class subtrees are NOT moved here — they are owned by separate,
 * differently-gated waves (#1902 data, #1903 state; G-15 classifies `agents/`
 * as per-agent state). They are enumerated as EXCLUSIONS in the journal so the
 * decision is auditable, and the resolver's legacy fallback keeps them readable
 * from the legacy tree until their own wave moves them.
 *
 * ── Migration primitive ──────────────────────────────────────────────────────
 * Every carry is a COPY that keeps the source for rollback and writes the
 * destination atomically: a fresh temp file is created O_EXCL (`wx`), written,
 * `fsync`'d, mode-preserved, then `rename`'d over the destination. The SOURCE is
 * NEVER renamed or removed — a mid-flight crash leaves the legacy tree fully
 * intact, and rollback simply deletes the canonical copies the journal records.
 *
 * ── Isolation ────────────────────────────────────────────────────────────────
 * Every path is derived from an injectable `home`, so the whole migrator runs
 * against a scratch `$HOME` with ZERO real-home access. Nothing here reads
 * `process.env.HOME` except through the seam's default when `home` is omitted.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { dirname, join, relative, sep } from "path";

import {
  cortexConfigDir,
  groveConfigPath,
  legacyCortexConfigDir,
} from "./config-path";

/** Journal file dropped at the canonical root so a move is auditable + reversible. */
export const MIGRATION_JOURNAL_NAME = ".xdg-config-migration.json";

/**
 * Top-level subtrees that are STATE/DATA-class and are OWNED by later, separately
 * gated waves — excluded from the config-only move (G-15 / #1902 / #1903). Kept
 * as a set so the exclusion decision is explicit + testable.
 */
export const EXCLUDED_TOP_DIRS: ReadonlySet<string> = new Set([
  "state", // pidfiles / runtime state — cortex#1903
  "agents", // per-agent state.sqlite — cortex#1903 (G-15)
  "logs", // rotating logs — cortex#1903
  "network-cache", // DD-10 registry cache — cortex#1902
  "networks", // live network runtime — cortex#1903
]);

/** Which legacy tree a carried file came from. */
export type LegacyTree = "cortex" | "grove";

export interface MoveRecord {
  /** Path relative to the config-dir root (POSIX-normalized with the tree's sep). */
  relPath: string;
  /** Which legacy tree the winning copy came from. */
  fromTree: LegacyTree;
  /** Absolute source path (kept; NEVER renamed or removed). */
  src: string;
  /** Absolute canonical destination path. */
  dest: string;
  /** File mode (low 12 bits) preserved onto the destination. */
  mode: number;
  /** Size in bytes of the carried file. */
  bytes: number;
  /**
   * When a grove copy was shadowed by a cortex-wins duplicate, its absolute
   * path (recorded for audit; the grove copy is left untouched, never deleted).
   */
  shadowedGrove?: string;
  /** Set once {@link executeConfigDirMigration} has written the destination. */
  applied?: boolean;
  /** Set when the destination already existed (canonical-wins) and was skipped. */
  skippedExisting?: boolean;
}

export interface ExclusionRecord {
  relPath: string;
  reason: string;
}

export interface MigrationJournal {
  version: 1;
  canonical: string;
  legacyCortex: string;
  grove: string;
  /** Caller-stamped ISO timestamp (kept out of the planner for determinism). */
  stampedAt?: string;
  moves: MoveRecord[];
  excluded: ExclusionRecord[];
}

export interface MigrateOptions {
  /** Override for `$HOME`. Omit only in production; tests ALWAYS pass a scratch home. */
  home?: string;
}

// ---------------------------------------------------------------- enumeration

/**
 * Recursively list files under `root`, returning paths RELATIVE to `root`.
 * Symlinks are recorded as files (their link, not the target, is carried) and
 * are never followed — a symlink out of the tree cannot smuggle a real-home
 * read into the copy. Top-level entries in {@link EXCLUDED_TOP_DIRS} are
 * skipped and reported separately by the planner.
 */
function walkFiles(root: string, excludeTop: ReadonlySet<string>): { files: string[]; excluded: string[] } {
  const files: string[] = [];
  const excluded: string[] = [];
  if (!existsSync(root)) return { files, excluded };

  const recurse = (absDir: string) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      const rel = relative(root, abs);
      const top = rel.split(sep)[0] ?? rel;
      if (absDir === root && excludeTop.has(e.name)) {
        excluded.push(rel);
        continue;
      }
      // Guard against an excluded dir reached via a deeper path too.
      if (excludeTop.has(top) && rel !== top) {
        continue; // already counted at the top level
      }
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        recurse(abs);
      } else {
        files.push(rel);
      }
    }
  };
  recurse(root);
  return { files, excluded };
}

/**
 * Build the migration plan (a {@link MigrationJournal} with NO writes performed).
 * Enumerates the union of both legacy trees, applies the merge policy, and lists
 * excluded state/data subtrees. Deterministic — safe to run repeatedly.
 */
export function planConfigDirMigration(opts: MigrateOptions = {}): MigrationJournal {
  const { home } = opts;
  const canonical = cortexConfigDir(home);
  const legacyCortex = legacyCortexConfigDir(home);
  // groveConfigPath("") yields the grove root with a trailing sep — normalize.
  const grove = dirname(groveConfigPath("x", home));

  const cortexScan = walkFiles(legacyCortex, EXCLUDED_TOP_DIRS);
  const groveScan = walkFiles(grove, EXCLUDED_TOP_DIRS);

  const cortexFiles = new Set(cortexScan.files);
  const moves: MoveRecord[] = [];
  const excluded: ExclusionRecord[] = [];

  const pushExcluded = (rel: string, tree: LegacyTree) =>
    excluded.push({ relPath: rel, reason: `state/data-class subtree (${tree}) — owned by #1902/#1903` });
  for (const rel of cortexScan.excluded) pushExcluded(rel, "cortex");
  for (const rel of groveScan.excluded) pushExcluded(rel, "grove");

  const record = (rel: string, tree: LegacyTree, srcRoot: string, shadowedGrove?: string) => {
    const src = join(srcRoot, rel);
    let st;
    try {
      st = statSync(src);
    } catch {
      return; // vanished between scan + stat — skip
    }
    const mode = st.mode & 0o777;
    const bytes = st.size;
    moves.push({ relPath: rel, fromTree: tree, src, dest: join(canonical, rel), mode, bytes, shadowedGrove });
  };

  // cortex-wins-on-dup: every flat-cortex file is carried; a same-rel grove copy
  // is recorded as shadowed (kept, never deleted).
  for (const rel of cortexScan.files) {
    const shadowed = groveScan.files.includes(rel) ? join(grove, rel) : undefined;
    record(rel, "cortex", legacyCortex, shadowed);
  }
  // grove-ONLY files are CARRIED (never lost).
  for (const rel of groveScan.files) {
    if (cortexFiles.has(rel)) continue; // already carried cortex-side
    record(rel, "grove", grove);
  }

  return { version: 1, canonical, legacyCortex, grove, moves, excluded };
}

// ------------------------------------------------------------- atomic primitive

/**
 * Atomically write `data` to `dest`, preserving `mode`: create a fresh temp file
 * O_EXCL (`wx`) in the destination directory, write + `fsync` it, `chmod` to
 * `mode`, then `rename` it over `dest`. A crash at any point leaves `dest`
 * either its old self or the new bytes — never a torn file. The temp name is
 * pid+counter unique so concurrent migrators never collide on it.
 */
export function atomicWriteFile(dest: string, data: Buffer, mode: number): void {
  mkdirSync(dirname(dest), { recursive: true });
  let fd: number;
  let tmp: string;
  for (let i = 0; ; i++) {
    const candidate = `${dest}.xdgtmp.${process.pid}.${i}`;
    try {
      fd = openSync(candidate, "wx", mode); // O_EXCL — never reuse a stale temp
      tmp = candidate;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST" && i < 10_000) continue;
      throw err;
    }
  }
  try {
    writeSync(fd, data);
    fsyncSync(fd); // durability: the bytes hit disk before the rename publishes them
  } finally {
    closeSync(fd);
  }
  // `wx` honors the umask, so re-assert the source mode (a 0600 secret must not widen).
  if (process.platform !== "win32") chmodSync(tmp, mode);
  try {
    // rename is atomic within a filesystem; if it throws, drop the temp so we
    // never leak a half-written sidecar next to the destination.
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// --------------------------------------------------------------- execution

/**
 * Execute a plan: atomically COPY each carried file into the canonical tree
 * (source kept), skipping any destination that already exists (canonical-wins),
 * then write the journal to `<canonical>/${MIGRATION_JOURNAL_NAME}`. Idempotent:
 * a second run re-skips already-carried files. Returns the journal with each
 * move's `applied`/`skippedExisting` flag set.
 *
 * @param stampedAt Optional ISO timestamp to record (caller-supplied so the
 *   library stays deterministic under test).
 */
export function executeConfigDirMigration(
  plan: MigrationJournal,
  stampedAt?: string,
): MigrationJournal {
  mkdirSync(plan.canonical, { recursive: true });
  for (const mv of plan.moves) {
    if (existsSync(mv.dest)) {
      mv.skippedExisting = true; // canonical-wins — never clobber a fresh-install copy
      continue;
    }
    const data = readFileSync(mv.src); // SOURCE is only ever READ, never renamed
    atomicWriteFile(mv.dest, data, mv.mode);
    mv.applied = true;
  }
  const journal: MigrationJournal = { ...plan, stampedAt };
  writeFileSync(join(plan.canonical, MIGRATION_JOURNAL_NAME), JSON.stringify(journal, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return journal;
}

/**
 * Roll a migration back: delete ONLY the canonical copies this journal recorded
 * as `applied` (the legacy trees, whose sources were kept, become authoritative
 * again via the resolver's fallback). Files that were `skippedExisting` are left
 * alone — they predate this migration and are not ours to remove. The journal
 * file itself is removed last. NEVER touches either legacy tree.
 *
 * @returns the number of canonical copies removed.
 */
export function rollbackConfigDirMigration(journal: MigrationJournal): number {
  let removed = 0;
  for (const mv of journal.moves) {
    if (!mv.applied) continue; // only undo what THIS migration wrote
    if (existsSync(mv.dest)) {
      rmSync(mv.dest, { force: true });
      removed++;
    }
  }
  rmSync(join(journal.canonical, MIGRATION_JOURNAL_NAME), { force: true });
  return removed;
}

/**
 * Load a previously-written journal from the canonical root, or `undefined` if
 * none exists (nothing has been migrated yet).
 */
export function loadMigrationJournal(opts: MigrateOptions = {}): MigrationJournal | undefined {
  const p = join(cortexConfigDir(opts.home), MIGRATION_JOURNAL_NAME);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as MigrationJournal;
  } catch {
    return undefined;
  }
}
