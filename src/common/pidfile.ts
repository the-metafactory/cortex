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
import { realpathSync, existsSync, renameSync } from "fs";

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
 * Continuity migration (cortex#1900 continuity AC) — adopt an existing
 * old-format pidfile so a live fleet is not orphaned mid-upgrade.
 *
 * Called once at daemon start, BEFORE the singleton check. If the NEW-format
 * pidfile is absent but the OLD-format one (`cortex-<basename>.pid`) exists in
 * `stateDir`, rename old → new. The running daemon's recorded PID travels with
 * the file, so the subsequent singleton check sees it (and correctly blocks a
 * duplicate if that PID is still alive, or reaps it if stale), and every reader
 * (`stop`/`status`/`reload`) now resolves the daemon under its new identity.
 *
 * No-op — returns `undefined` — when: the config is default/unspecified (never
 * suffixed), the new-format file already exists (already migrated / fresh
 * install), or no old-format file is present. Returns the adopted old path (for
 * the caller to log) when a rename happened.
 *
 * `stateDir` defaults to {@link STATE_DIR}; it is overridable purely for
 * test isolation (the rename is a real filesystem mutation).
 *
 * Safety: this deliberately does NOT run inside `pidFileFor` (a pure resolver
 * with many read-only callers) — only `start` mutates the filesystem. And ONLY
 * `start` consults the old name; readers never do, so two trees sharing a
 * basename can never both be steered back onto the shared `cortex-<basename>.pid`.
 * The old name is inherently tree-ambiguous (that is the bug #1900 fixes), so
 * the FIRST tree to start after upgrade claims it. That is safe under the
 * epic's ordering — #1900 lands BEFORE the X-07 config copy, so at migration
 * time only ONE tree (hence one old-format pidfile) exists.
 */
export function migrateLegacyPidFile(
  configPath: string | undefined,
  stateDir: string = STATE_DIR,
): string | undefined {
  const target = pidFileForIn(stateDir, configPath);
  const legacy = legacyPidFileForIn(stateDir, configPath);
  if (legacy === undefined) return undefined; // default config: never suffixed
  if (legacy === target) return undefined; // defensive: nothing to rename
  if (existsSync(target)) return undefined; // already on the new format
  if (!existsSync(legacy)) return undefined; // nothing to adopt
  renameSync(legacy, target);
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
