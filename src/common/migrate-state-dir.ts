/**
 * XDG wave-5 (cortex#1903, EPIC cortex#1867 §P3c) — STATE DIRECTORY migrator.
 *
 * The RISKIEST move in the epic: it relocates the pidfiles of production
 * daemons. So it is GATED twice over and copy-keep-source throughout.
 *
 * ── What moves (all copy-keep-source, source NEVER deleted here) ─────────────
 *   - pidfiles + `.degraded.json` markers  `~/.config/grove/state`      → canonical
 *   - rotating logs                         `~/.config/grove/logs` AND
 *                                           `~/.config/cortex/logs`      → canonical/logs
 *   - relay pidfile                         `~/.claude/relay/relay.pid`  → canonical/relay
 *   - DD-10 network-cache (signed roster)   `~/.config/cortex/network-cache` → canonical/network-cache
 *
 * The network-cache carry preserves the signature-verified roster byte-for-byte
 * (a plain file copy of the `*.json` records — no re-serialize, no truncation),
 * so `NetworkCache.load`'s `BASE64_ED25519` grammar + shape gate still passes and
 * the offline-fallback roster survives intact (AC2).
 *
 * ── Two gates, because a name-belt is INSUFFICIENT for a directory move ──────
 *   1. **X-09 service gate** ({@link withMigrationGate}) — `launchctl bootout` /
 *      `systemctl stop` every discovered stack + relay + legacy unit, then PROVE
 *      each dead via the three-leg positive-death proof AND the config-derived
 *      pidfile-liveness belt. The migration body runs ONLY if the gate clears,
 *      inside a try/finally that ALWAYS restores the pre-running fleet.
 *   2. **Directory-occupancy precondition** ({@link stateDirOccupancyCheck}) —
 *      run INSIDE the gated body, AFTER the service stop. The service gate + its
 *      belt only see daemons the service manager knows about OR whose pidfile
 *      NAME the #1900 `pidFileFor` can reconstruct. A directory MOVE needs more:
 *      we `readdir` the actual state dirs (source + canonical + relay) and
 *      liveness-check EVERY `*.pid` we find, by name-agnostic enumeration. If ANY
 *      maps to a LIVE process → ABORT. A `*.pid` we cannot classify (unreadable /
 *      unparseable / no such pid file content) counts as PRESENT (fail-safe
 *      abort), NEVER absent (belt re-attack #1932). Only when every pidfile on
 *      disk is provably dead/gone does the carry proceed.
 *
 * ── Transactionality ─────────────────────────────────────────────────────────
 * {@link executeStateDirMigration} is all-or-nothing: on ANY throw mid-carry it
 * rolls back every carry it applied, so the existence-gated resolver never sees a
 * PARTIAL canonical that would shadow files still in a legacy tree. The legacy
 * trees are never touched.
 *
 * ── Isolation ────────────────────────────────────────────────────────────────
 * Every path derives from an injectable `home`; process-liveness is the injected
 * `procAlive` seam; the service gate's exec/sleep/clock are injected via
 * {@link ClearFleetOptions}. The whole migrator runs against a scratch `$HOME`
 * with no real launchd/systemd/processes.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";

import { atomicSymlink, atomicWriteFile } from "./config/migrate-config-dir";
import {
  type ClearFleetOptions,
  type MigrationGateResult,
  type RestoreResult,
  withMigrationGate,
} from "./migration/migration-gate";
import {
  canonicalLogsDir,
  canonicalNetworkCacheDir,
  canonicalPidStateDir,
  canonicalRelayDir,
  cortexStateDir,
  cortexStateDirOverride,
  legacyCortexLogsDir,
  legacyGroveLogsDir,
  legacyNetworkCacheDir,
  legacyPidStateDir,
  legacyRelayDir,
  STATE_MIGRATION_JOURNAL_NAME,
} from "./state-path";

// The completion-marker filename is owned by `state-path.ts` (the resolver's
// canonical gate reads it), and re-exported here so callers that write/inspect
// the journal keep importing it from the migrator. Writing this file at the
// canonical root is precisely what flips `stateMigrationCompleted` → true.
export { STATE_MIGRATION_JOURNAL_NAME };

/** Which state class a carried entry belongs to (for audit + reasoning). */
export type StateCarryKind = "pidfiles" | "logs" | "relay-pid" | "network-cache";

export interface StateMoveRecord {
  kind: StateCarryKind;
  /** Path relative to its carry root (POSIX-normalized with the tree's sep). */
  relPath: string;
  /** Absolute source path (KEPT; never renamed or removed). */
  src: string;
  /** Absolute canonical destination path. */
  dest: string;
  /** File mode (low 12 bits) preserved onto the destination. */
  mode: number;
  /** Size in bytes of the carried file. */
  bytes: number;
  /** True when carried AS a symlink (link text, never dereferenced). */
  symlink?: boolean;
  /** For a symlink entry, the raw `readlinkSync` text (may dangle). */
  linkTarget?: string;
  /** Set once {@link executeStateDirMigration} wrote the destination. */
  applied?: boolean;
  /** Set when the destination already existed (canonical-wins) and was skipped. */
  skippedExisting?: boolean;
}

export interface StateMigrationJournal {
  version: 1;
  canonical: string;
  carried: StateMoveRecord[];
  /** Caller-stamped ISO timestamp (kept out of the planner for determinism). */
  stampedAt?: string;
}

export interface StateMigrateOptions {
  /** Override for `$HOME`. Omit only in production; tests ALWAYS pass a scratch home. */
  home?: string;
}

// =============================================================================
// Directory-occupancy precondition (the belt-insufficiency fix, #1932)
// =============================================================================

/** One `*.pid` on disk that refuses the move — either LIVE or unclassifiable. */
export interface OccupiedPidfile {
  path: string;
  /** The parsed pid when the file was readable + parseable, else `undefined`. */
  pid?: number;
  /**
   *  - `live`         — parsed to a pid that `procAlive` reports RUNNING.
   *  - `unreadable`   — the file could not be read (fail-safe PRESENT).
   *  - `unparseable`  — read but not a positive integer pid (fail-safe PRESENT).
   */
  reason: "live" | "unreadable" | "unparseable";
}

export interface OccupancyResult {
  /** True when ANY pidfile is live OR unclassifiable → the move MUST abort. */
  occupied: boolean;
  /** Every refusing pidfile, with why (for the abort log). */
  refused: OccupiedPidfile[];
  /** Dirs actually scanned (existing ones only). */
  scanned: string[];
}

/**
 * Directory-occupancy precondition. `readdir` each dir in `dirs` and liveness-
 * check EVERY `*.pid` found — name-agnostic, so it catches pidfiles the #1900
 * `pidFileFor` name-reconstruction belt cannot (custom/legacy names, orphans,
 * the relay pidfile). Classification, fail-safe toward PRESENT:
 *   - readable + parseable + `procAlive` true → `live`         (refuse).
 *   - readable + parseable + `procAlive` false → dead          (allow).
 *   - unreadable                              → `unreadable`   (refuse).
 *   - readable but not a positive-int pid     → `unparseable`  (refuse).
 * A dir that does not exist is skipped (nothing to occupy). NEVER throws — an
 * unreadable DIR entry is treated conservatively (the pidfiles it would contain
 * are unknown, so a readdir failure on a present dir refuses via a synthetic
 * `unreadable` marker rather than silently clearing).
 */
export function stateDirOccupancyCheck(
  dirs: readonly string[],
  procAlive: (pid: number) => boolean,
): OccupancyResult {
  const refused: OccupiedPidfile[] = [];
  const scanned: string[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!existsSync(dir)) continue;
    scanned.push(dir);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // A present-but-unreadable state dir hides an unknown set of pidfiles —
      // fail-safe: refuse rather than infer "empty" (belt-insufficiency #1932).
      refused.push({ path: join(dir, "*.pid"), reason: "unreadable" });
      continue;
    }

    for (const name of entries) {
      if (!name.endsWith(".pid")) continue;
      const pidPath = join(dir, name);
      let text: string;
      try {
        text = readFileSync(pidPath, "utf-8");
      } catch {
        refused.push({ path: pidPath, reason: "unreadable" });
        continue;
      }
      const pid = parseInt(text.trim(), 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        // A `.pid` file we cannot classify counts as PRESENT, never absent.
        refused.push({ path: pidPath, reason: "unparseable" });
        continue;
      }
      if (procAlive(pid)) {
        refused.push({ path: pidPath, pid, reason: "live" });
      }
      // else: parseable + dead → not an occupant (the legit post-gate case).
    }
  }

  return { occupied: refused.length > 0, refused, scanned };
}

/** The dirs the occupancy precondition scans: the source pid/relay dirs AND
 *  their canonical counterparts (a daemon that already booted on the new binary
 *  wrote canonical-side), unioned + de-duped. Honors the `home` seam. */
export function occupancyScanDirs(home?: string): string[] {
  return [
    legacyPidStateDir(home),
    canonicalPidStateDir(home),
    legacyRelayDir(home),
    canonicalRelayDir(home),
  ];
}

// =============================================================================
// Plan (pure — NO writes)
// =============================================================================

/** Recursively list files under `root`, RELATIVE to `root`. `lstat`, never
 *  follow: a symlink (file OR dir) is a single leaf entry, carried as a link. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const recurse = (absDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) recurse(abs);
      else out.push(relative(root, abs));
    }
  };
  recurse(root);
  return out;
}

/** Build one carry record (file OR symlink), or `undefined` if the source
 *  vanished between the walk and the stat. */
function record(
  kind: StateCarryKind,
  relPath: string,
  srcRoot: string,
  destRoot: string,
): StateMoveRecord | undefined {
  const src = join(srcRoot, relPath);
  let st;
  try {
    st = lstatSync(src); // lstat: a symlink is carried AS a symlink, never followed
  } catch {
    return undefined;
  }
  const mode = st.mode & 0o777;
  const bytes = st.size;
  const dest = join(destRoot, relPath);
  if (st.isSymbolicLink()) {
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(src);
    } catch {
      return undefined;
    }
    return { kind, relPath, src, dest, mode, bytes, symlink: true, linkTarget };
  }
  return { kind, relPath, src, dest, mode, bytes };
}

/** One (kind, srcRoot, destRoot) carry unit. A single-file unit uses the file's
 *  parent as the root and its basename as the sole relPath. */
interface CarryUnit {
  kind: StateCarryKind;
  srcRoot: string;
  destRoot: string;
  /** When set, carry ONLY this basename under the roots (single-file unit). */
  onlyFile?: string;
}

function carryUnits(home?: string): CarryUnit[] {
  return [
    { kind: "pidfiles", srcRoot: legacyPidStateDir(home), destRoot: canonicalPidStateDir(home) },
    { kind: "logs", srcRoot: legacyGroveLogsDir(home), destRoot: canonicalLogsDir(home) },
    { kind: "logs", srcRoot: legacyCortexLogsDir(home), destRoot: canonicalLogsDir(home) },
    {
      kind: "network-cache",
      srcRoot: legacyNetworkCacheDir(home),
      destRoot: canonicalNetworkCacheDir(home),
    },
    {
      kind: "relay-pid",
      srcRoot: legacyRelayDir(home),
      destRoot: canonicalRelayDir(home),
      onlyFile: "relay.pid", // relay-policy.yaml is CONFIG and stays put
    },
  ];
}

/**
 * Build the migration plan (a {@link StateMigrationJournal} with NO writes).
 * Enumerates each carry unit's legacy tree and maps it to the canonical tree.
 * Deterministic — safe to run repeatedly. An explicit `$CORTEX_STATE_DIR` root
 * has no legacy counterpart, so the plan is EMPTY (nothing to carry).
 */
export function planStateDirMigration(opts: StateMigrateOptions = {}): StateMigrationJournal {
  const { home } = opts;
  const canonical = cortexStateDir(home);
  const carried: StateMoveRecord[] = [];
  if (cortexStateDirOverride() !== undefined) return { version: 1, canonical, carried };

  const seenDest = new Set<string>();
  for (const unit of carryUnits(home)) {
    const rels = unit.onlyFile !== undefined ? [unit.onlyFile] : walkFiles(unit.srcRoot);
    for (const rel of rels) {
      // A single-file unit lists its basename even when absent — skip a missing one.
      if (unit.onlyFile !== undefined && !existsSync(join(unit.srcRoot, rel))) continue;
      const mv = record(unit.kind, rel, unit.srcRoot, unit.destRoot);
      if (mv === undefined) continue;
      // Two log units can converge on the same canonical dest (grove + cortex).
      // First-writer-wins in the PLAN (grove precedes cortex); execute's
      // existsSync canonical-wins guard handles the rest.
      if (seenDest.has(mv.dest)) continue;
      seenDest.add(mv.dest);
      carried.push(mv);
    }
  }
  return { version: 1, canonical, carried };
}

// =============================================================================
// Execute (transactional)
// =============================================================================

/**
 * Execute a plan: atomically carry each entry into the canonical tree (source
 * kept) — a regular file via {@link atomicWriteFile}, a symlink AS a symlink via
 * {@link atomicSymlink} — skipping any destination that already exists
 * (canonical-wins), then write the journal. Idempotent: a second run re-skips
 * already-carried files.
 *
 * TRANSACTIONAL: if any carry throws, every carry THIS invocation applied is
 * rolled back before the original error re-throws — so the resolver (which flips
 * to canonical on mere directory existence) never sees a partial canonical.
 */
export function executeStateDirMigration(
  plan: StateMigrationJournal,
  stampedAt?: string,
): StateMigrationJournal {
  const canonicalPreexisted = existsSync(plan.canonical);
  mkdirSync(plan.canonical, { recursive: true });
  try {
    for (const mv of plan.carried) {
      if (existsSync(mv.dest)) {
        mv.skippedExisting = true; // canonical-wins — never clobber a fresh copy
        continue;
      }
      if (mv.symlink) {
        atomicSymlink(mv.dest, mv.linkTarget ?? "");
      } else {
        const data = readFileSync(mv.src); // SOURCE is only ever READ, never renamed
        atomicWriteFile(mv.dest, data, mv.mode);
      }
      mv.applied = true;
    }
  } catch (err) {
    for (const mv of plan.carried) {
      if (!mv.applied) continue;
      let present = true;
      try {
        lstatSync(mv.dest);
      } catch {
        present = false;
      }
      if (present) rmSync(mv.dest, { force: true });
      mv.applied = false;
    }
    if (!canonicalPreexisted) rmSync(plan.canonical, { recursive: true, force: true });
    throw err; // preserve the original error — never swallow it
  }
  const journal: StateMigrationJournal = { ...plan, stampedAt };
  writeFileSync(join(plan.canonical, STATE_MIGRATION_JOURNAL_NAME), JSON.stringify(journal, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return journal;
}

// =============================================================================
// The gated orchestrator (the BLESSED cutover entry)
// =============================================================================

/** Why a state migration did not carry anything. */
export type StateMigrationOutcome =
  | "migrated" // gate cleared, dir unoccupied, carry ran (or was already done)
  | "gate-refused" // X-09 gate refused to prove the fleet dead
  | "dir-occupied"; // a live/unclassifiable pidfile on disk (belt-insufficiency abort)

export interface StateMigrationRunResult {
  outcome: StateMigrationOutcome;
  /** The X-09 gate verdict (always present — the gate always runs). */
  gate: MigrationGateResult;
  /** The finally-guaranteed fleet restore outcome. */
  restore: RestoreResult;
  /** The occupancy verdict — present only when the gate cleared (so we ran it). */
  occupancy?: OccupancyResult;
  /** The journal — present only on `migrated`. */
  journal?: StateMigrationJournal;
}

export interface MigrateStateDirOptions extends ClearFleetOptions {
  /** Override for `$HOME`. Tests ALWAYS pass a scratch home. */
  home?: string;
  /** ISO timestamp stamped into the journal (caller-supplied for determinism). */
  stampedAt?: string;
  /** Extra dirs to scan for occupancy beyond {@link occupancyScanDirs} (tests). */
  extraOccupancyDirs?: readonly string[];
}

/**
 * Run the STATE-dir migration behind BOTH gates (the BLESSED cutover entry).
 *
 * Flow:
 *   1. {@link withMigrationGate} stops + proves-dead the fleet (X-09). If it
 *      refuses, NOTHING is carried and the fleet is restored → `gate-refused`.
 *   2. Inside the gated body (fleet proven down), the directory-occupancy
 *      precondition scans the real state dirs. Any LIVE or unclassifiable
 *      `*.pid` → NOTHING is carried → `dir-occupied` (the belt-insufficiency
 *      abort). The finally still restores the fleet.
 *   3. Otherwise {@link executeStateDirMigration} carries every legacy state
 *      file to canonical (copy-keep-source, atomic, transactional) → `migrated`.
 *
 * The fleet is ALWAYS restored (withMigrationGate's try/finally), so exactly the
 * pre-running set comes back — one live process per stack (AC3).
 */
export async function migrateStateDir(
  opts: MigrateStateDirOptions = {},
): Promise<StateMigrationRunResult> {
  const { home, stampedAt, extraOccupancyDirs, ...gateOpts } = opts;
  const procAlive = gateOpts.env?.procAlive ?? defaultProcAlive;

  // The gated body is fully synchronous (occupancy scan + copy-keep-source carry),
  // so it returns an already-resolved Promise rather than being `async` (no await
  // to make — the service gate's async stop/prove-dead is inside withMigrationGate).
  const run = await withMigrationGate(
    gateOpts,
    (): Promise<{ occupancy: OccupancyResult; journal?: StateMigrationJournal }> => {
      const scanDirs = [...occupancyScanDirs(home), ...(extraOccupancyDirs ?? [])];
      const occupancy = stateDirOccupancyCheck(scanDirs, procAlive);
      if (occupancy.occupied) {
        // Belt-insufficiency abort: a directory move needs a directory-occupancy
        // proof, not just the name-reconstruction belt. Carry NOTHING.
        return Promise.resolve({ occupancy });
      }
      const journal = executeStateDirMigration(
        planStateDirMigration(home !== undefined ? { home } : {}),
        stampedAt,
      );
      return Promise.resolve({ occupancy, journal });
    },
  );

  if (!run.cleared) {
    return { outcome: "gate-refused", gate: run.gate, restore: run.restore };
  }
  const body = run.result;
  const occupancy = body?.occupancy;
  if (body?.journal === undefined) {
    return {
      outcome: "dir-occupied",
      gate: run.gate,
      restore: run.restore,
      ...(occupancy !== undefined && { occupancy }),
    };
  }
  return {
    outcome: "migrated",
    gate: run.gate,
    restore: run.restore,
    ...(occupancy !== undefined && { occupancy }),
    journal: body.journal,
  };
}

/** The real `kill(pid,0)` liveness probe, EPERM-as-alive / ESRCH-as-dead
 *  (matches the gate's `bunGateEnv.procAlive`). */
function defaultProcAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code !== "ESRCH";
  }
}
