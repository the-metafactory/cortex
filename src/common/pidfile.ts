/**
 * Daemon PID-file path resolution — single source of truth shared by the
 * `cortex start/stop/status` lifecycle (in `cortex.ts`) and the
 * `cortex agents reload` runtime-signal path (in `cli/cortex/commands/agents.ts`).
 *
 * Lives in its own tiny module (no heavy import graph) so the lightweight
 * `agents` CLI can resolve the running runtime's PID without pulling the whole
 * `cortex.ts` module graph in just for `pidFileFor`. Imports stay limited to
 * Node builtins (`os`/`path`/`fs`/`crypto`) — deliberately NO config-schema
 * import: keying the pidfile on `stack.id` would need the schema graph, and
 * (per cortex#1900) the full config PATH is a stricter identity anyway, so we
 * hash the path here instead of parsing the file.
 *
 * PID-file naming (cortex#1900):
 *   - Default / unspecified config → legacy `cortex.pid` (single-instance
 *     backward compat, unchanged).
 *   - Custom config → `cortex-<basename>-<hash8>.pid`, where `<basename>` is
 *     the config filename without its `.ya?ml` extension (human-readable slug)
 *     and `<hash8>` is the first 8 hex chars of sha256(canonical FULL path).
 *     The hash is what makes two config TREES that share a filename (the X-07
 *     copy-keep-original window) resolve to DISTINCT pidfiles — basename alone
 *     collided, SIGTERM-ing the wrong tree's daemon.
 *   - Pre-#1900 custom pidfiles were `cortex-<basename>.pid` (no hash). A live
 *     fleet upgrading across this change is carried forward by
 *     {@link migrateLegacyPidFile} (rename-on-start), never orphaned.
 *
 * MIG-7.9 (deferred) flips these to `~/.config/cortex/`. Keeping grove-shaped
 * paths for now so the principal's existing `bot.yaml` continues to work.
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join, basename } from "path";
import { realpathSync, existsSync, renameSync, readFileSync } from "fs";

/**
 * State directory holding every pidfile (and the degraded-state markers derived
 * from them). `CORTEX_STATE_DIR` overrides it — the STATE env seam (cortex#1908
 * CONFIG/EVENTS/STATE trio). This is the SOLE state constructor in the tree, so
 * the STATE read lands here rather than being split across files (which would
 * desync cortex.ts's `mkdirSync(STATE_DIR)` from `PID_FILE`/`pidFileFor`
 * derivation). Like `HOME`, it is read ONCE at import (T1b): the resolved value
 * is a module constant, so processes needing an override must set the env
 * before the module loads — the value does not track later `process.env`
 * mutation. `.trim()` + `||` means a blank/whitespace override falls back to the
 * grove default rather than resolving pidfiles into an empty-string path.
 */
export const STATE_DIR =
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- `||` is intentional: a blank/whitespace CORTEX_STATE_DIR trims to "" (falsy but not null), and MUST fall back to the grove default; `??` would keep the empty string and resolve pidfiles into a rootless path.
  process.env.CORTEX_STATE_DIR?.trim() ||
  join(process.env.HOME ?? "~", ".config", "grove", "state");
export const PID_FILE = join(STATE_DIR, "cortex.pid");
export const DEFAULT_CONFIG = join(
  process.env.HOME ?? "~",
  ".config",
  "grove",
  "bot.yaml",
);

/**
 * The custom-config identity components: the human-readable `<basename>` slug
 * and the `canonical` full path it derives from. Returns `undefined` for every
 * case that collapses to the single-instance legacy `cortex.pid` — unspecified
 * config, the default config (both by raw compare AND post-canonicalization),
 * and a degenerate empty basename. Centralizing this keeps `pidFileFor` and
 * {@link legacyPidFileFor} deriving `<basename>` from the SAME canonical path,
 * so the new-format and old-format names line up for the continuity migration.
 */
function customPidComponents(
  configPath: string | undefined,
): { base: string; canonical: string } | undefined {
  // Preserve the raw default-config short-circuit (cortex#1900 AC): a literal
  // DEFAULT_CONFIG never touches realpath and always maps to PID_FILE.
  if (configPath === undefined || configPath === DEFAULT_CONFIG) {
    return undefined;
  }
  const canonical = canonicalizeConfigPath(configPath);
  if (canonical === DEFAULT_CONFIG) {
    return undefined;
  }
  const base = basename(canonical).replace(/\.ya?ml$/i, "");
  if (base.length === 0) return undefined;
  return { base, canonical };
}

/**
 * New-format (cortex#1900) pidfile path within an explicit `stateDir`:
 * `<stateDir>/cortex-<basename>-<hash8>.pid`, or `<stateDir>/cortex.pid` for
 * the legacy/default case. `stateDir` is a seam so tests can exercise the real
 * derivation in a temp dir (test-isolation rule: never write into the real
 * `~/.config/grove/state`); production always uses {@link STATE_DIR}.
 */
function pidFileForIn(stateDir: string, configPath: string | undefined): string {
  const c = customPidComponents(configPath);
  if (c === undefined) return join(stateDir, "cortex.pid");
  const hash = createHash("sha256").update(c.canonical).digest("hex").slice(0, 8);
  return join(stateDir, `cortex-${c.base}-${hash}.pid`);
}

/**
 * Pre-cortex#1900 (old-format) pidfile path within `stateDir`:
 * `<stateDir>/cortex-<basename>.pid`, with NO path hash — or `undefined` when
 * the config maps to the legacy `cortex.pid` (which never carried a suffix, so
 * needs no migration).
 */
function legacyPidFileForIn(
  stateDir: string,
  configPath: string | undefined,
): string | undefined {
  const c = customPidComponents(configPath);
  if (c === undefined) return undefined;
  return join(stateDir, `cortex-${c.base}.pid`);
}

/**
 * Resolve the PID file path for a given `--config` value.
 *
 * Resolution:
 *   - Default config (or unspecified) → legacy `cortex.pid` (single-instance
 *     backward compat).
 *   - Custom config → `cortex-<basename>-<hash8>.pid` — the config filename
 *     (without the `.yaml`/`.yml` extension) plus the first 8 hex chars of
 *     sha256(canonical full path). Two config TREES that share a basename get
 *     DISTINCT PID files because their full paths hash differently.
 *
 * cortex#1900 — **keyed on the full config PATH, not the basename.** Under the
 * old basename-only scheme, `<dirA>/stack.yaml` and `<dirB>/stack.yaml` both
 * mapped to `cortex-stack.pid`: `start` on one saw the other "already running"
 * and `stop` on one SIGTERM-ed the other's daemon. Hashing the canonical full
 * path removes that collision class while the basename slug keeps the file
 * human-readable.
 *
 * Sage cortex#1027 — **canonicalized against config-path spelling.** The PID
 * file is a lifecycle identity: `cortex start --config X` (writer) and
 * `cortex agents reload --config X` / `cortex stop --config X` (readers) must
 * resolve the same file across spellings. Covered: trailing slash, `./`/`..`
 * detours, symlinks, relative-vs-absolute, and `~` (expanded here) — for
 * configs that EXIST on disk, via `realpathSync`. Honest limit: when the path
 * does not resolve (file missing/unreadable) we fall back to the trimmed
 * literal, so two never-on-disk spellings of the same intended file can still
 * derive different PID files — callers get convergence for real configs, not
 * for hypothetical ones. The hash is taken over that same canonical value, so
 * it inherits exactly this convergence (no weaker, no stronger).
 */
export function pidFileFor(configPath: string | undefined): string {
  return pidFileForIn(STATE_DIR, configPath);
}

/**
 * If `legacyPath` names a process that is still ALIVE, return that PID;
 * otherwise (dead/stale PID, or the file is unreadable / unparseable) return
 * `undefined`. A LIVE PID is the adoption hazard (see
 * {@link migrateLegacyPidFile}): it means a daemon is running RIGHT NOW under
 * the tree-ambiguous old name, and we must not rename its pidfile out from
 * under it. A dead/stale/unreadable PID is the legitimate restart-to-migrate
 * signature and is safe to adopt.
 *
 * `EPERM` (a process with that PID exists but is owned by another user) counts
 * as alive — conservatively refuse to adopt. Only `ESRCH` (no such process) is
 * treated as dead.
 */
function legacyLivePid(legacyPath: string): number | undefined {
  let pid: number;
  try {
    pid = parseInt(readFileSync(legacyPath, "utf-8").trim(), 10);
  } catch {
    return undefined; // unreadable → treat as stale → safe to adopt
  }
  if (Number.isNaN(pid)) return undefined; // unparseable → stale → safe to adopt
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, delivers nothing
    return pid; // delivered → alive → hazard
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
  }
}

/**
 * Continuity migration (cortex#1900 continuity AC) — adopt an existing
 * old-format pidfile so a live fleet is not orphaned mid-upgrade.
 *
 * Called once at daemon start, BEFORE the singleton check. If the NEW-format
 * pidfile is absent but the OLD-format one (`cortex-<basename>.pid`) exists in
 * `stateDir` AND names a DEAD/stale PID, rename old → new. Every reader
 * (`stop`/`status`/`reload`) then resolves the daemon under its new identity.
 *
 * **Liveness gate (adv PR#1923, blocking).** The old name is tree-ambiguous —
 * two config trees that share a basename (a manual `cp -r` of a config tree +
 * an in-place binary upgrade reaches this with NO X-07 involved) both derive
 * `cortex-<basename>.pid`. If that file names a LIVE process, adopting it would
 * rename a *foreign, running* daemon's pidfile under THIS config's identity —
 * so a later `stop <this>` would SIGTERM the other tree's daemon while
 * `stop <other>` reports "not running". So: a live legacy PID is REFUSED
 * (warn + return `undefined`); only a dead/stale/unreadable PID is adopted.
 * This is sound because the legit restart-to-migrate path never presents a live
 * legacy PID: a clean shutdown unlinks its own pidfile, and an unclean exit
 * leaves a DEAD pid — a LIVE pid is the hazard's signature, nothing else.
 *
 * **Accepted trade-off (documented).** Restarting the SAME config while its old
 * daemon is still live now boots toward `checkSingleton` on the NEW name (which
 * is absent) and may spawn a DUPLICATE rather than block on the old name. That
 * is strictly less catastrophic than a cross-tree SIGTERM, and the principal is
 * told to stop the old daemon first.
 *
 * **Guarded rename.** The rename is wrapped: `ENOENT`/`EEXIST` = a benign
 * migration race we lost (a concurrent start already migrated / removed the
 * file) → nothing to do. Any other error → warn and continue. A continuity
 * nicety must NEVER abort daemon boot — a throw here becomes `exit(1)` under
 * launchd KeepAlive, i.e. an invisible crash-loop.
 *
 * No-op — returns `undefined` — when: the config is default/unspecified (never
 * suffixed), the new-format file already exists, no old-format file is present,
 * the old-format file names a LIVE process, or the rename lost a race. Returns
 * the adopted old path (for the caller to log) only when a rename succeeded.
 *
 * `stateDir` defaults to {@link STATE_DIR} (which now honours `CORTEX_STATE_DIR`)
 * and is overridable purely for test isolation. `onBeforeRename` is a
 * test-only seam invoked after the pre-flight checks and immediately before the
 * rename, so a test can simulate a lost race; never passed in production.
 */
export function migrateLegacyPidFile(
  configPath: string | undefined,
  stateDir: string = STATE_DIR,
  onBeforeRename?: () => void,
): string | undefined {
  const target = pidFileForIn(stateDir, configPath);
  const legacy = legacyPidFileForIn(stateDir, configPath);
  if (legacy === undefined) return undefined; // default config: never suffixed
  if (legacy === target) return undefined; // defensive: nothing to rename
  if (existsSync(target)) return undefined; // already on the new format
  if (!existsSync(legacy)) return undefined; // nothing to adopt

  // Liveness gate: refuse to adopt a pidfile whose daemon is still running.
  const alivePid = legacyLivePid(legacy);
  if (alivePid !== undefined) {
    console.error(
      `cortex: live legacy pidfile ${legacy} (pid ${alivePid}) — not adopting; ` +
        `stop that daemon first or restart it under the new binary`,
    );
    return undefined;
  }

  onBeforeRename?.(); // test seam only
  try {
    renameSync(legacy, target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST") {
      // Non-race failure (e.g. EACCES): don't crash boot — the daemon still
      // starts on the new-format name; it just didn't inherit the old file.
      console.error(
        `cortex: could not migrate legacy pidfile ${legacy} → ${target}: ${(err as Error).message}`,
      );
    }
    return undefined;
  }
  return legacy;
}

/**
 * Canonicalize a config locator so different spellings of the same file map to
 * one identity. Resolves symlinks + `.`/`..` via `realpathSync`; when the path
 * does not exist on disk yet (e.g. resolving the PID file before the config is
 * created), falls back to the raw path so the previous basename behaviour is
 * preserved. Always strips a single trailing slash so a directory-style spelling
 * of a file path does not skew the basename.
 */
function canonicalizeConfigPath(configPath: string): string {
  let trimmed = configPath.replace(/\/+$/, "");
  // `~` never reaches realpath (shells expand it, but config values passed
  // programmatically may carry it verbatim).
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    trimmed = join(homedir(), trimmed.slice(1));
  }
  try {
    return realpathSync(trimmed);
  } catch {
    // Path not on disk (yet) or unreadable — realpath can't canonicalize it.
    // Fall back to the trimmed literal so the basename derivation still runs;
    // two on-disk spellings of an EXISTING file still converge via the try-path.
    return trimmed;
  }
}
