/**
 * GV-1 (cortex#1076, EPIC cortex#1075 Phase 1) — config-FILE path resolver.
 *
 * The metafactory config directory is migrating from `~/.config/grove/` to
 * `~/.config/cortex/`. This module is the single, shared place that resolves a
 * config FILE (cli.yaml, bot.yaml, cloud-credentials.txt, mission-control.yaml,
 * …) under that directory with **cortex-first / grove-fallback** precedence
 * during the transition window.
 *
 * Precedence (read):
 *   1. `~/.config/cortex/<file>`  — canonical; used if it exists.
 *   2. `~/.config/grove/<file>`   — legacy fallback; used only if the cortex
 *      copy is absent AND the grove copy exists.
 *   3. `~/.config/cortex/<file>`  — the write/default target when NEITHER
 *      exists (a fresh install writes cortex-side, never grove-side).
 *
 * SCOPE — this owns config FILES ONLY. It deliberately does NOT touch the live
 * runtime state the same directory also holds (`state/`, `networks/`, `logs/`,
 * `personas/`). Renaming those is a later, separately-sequenced step (the
 * running daemon reads/writes them live); doing it here would disrupt a
 * running stack. See cortex#1075.
 *
 * Also out of scope: the `GROVE_*` → `CORTEX_*` ENV-VAR tier (separate shim,
 * cortex#774) and any `grove`-as-guild-name / `the-metafactory/grove` repo refs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * XDG wave-1 (cortex#1908, EPIC cortex#1867 X-03) — CONFIG_DIR env seam.
 *
 * `CORTEX_CONFIG_DIR`, when set, is the cortex config directory VERBATIM (the
 * default is bypassed), so a hermetic guard (#1870) can point config resolution
 * at a scratch dir with ZERO real-home access. `CORTEX_STATE_DIR` is owned by
 * #1900; `CORTEX_EVENTS_DIR` lives in `events-path.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * XDG wave-4 (cortex#1869, EPIC cortex#1867 §P3a) — CONFIG DIRECTORY MOVE.
 *
 * The canonical config directory is now `~/.config/metafactory/cortex`, folded
 * under the shared `metafactory` XDG root (matching the wave-3 `~/.local/bin`
 * cutover). The two pre-move trees are READ-FALLBACKS during the transition,
 * in precedence order:
 *
 *   1. `~/.config/metafactory/cortex/<file>` — canonical (or `$CORTEX_CONFIG_DIR`).
 *   2. `~/.config/cortex/<file>`             — legacy flat cortex tree.
 *   3. `~/.config/grove/<file>`              — legacy grove tree (oldest).
 *   4. canonical path                        — write/default target when none exist.
 *
 * The physical move (merge-policy union of the two legacy trees, atomic-write +
 * journal + rollback, plist re-render + `launchctl bootout/bootstrap`) lives in
 * `migrate-config-dir.ts`; this module is only the RESOLVER (which tree a path
 * reads from) plus the per-file auto-migrate helper. Every legacy-tree hit is
 * surfaced via {@link noteXdgFallback} so a `CORTEX_XDG_STRICT=1` fresh-install
 * run stays silent (Fallback Contract, cortex#1867 / removal owned by #1904).
 */

import { copyFileSync, existsSync, mkdirSync, statSync, chmodSync } from "fs";
import { dirname, join } from "path";

import { noteXdgFallback, readDirEnv } from "../xdg";

/** The shared metafactory XDG root under `~/.config` (wave-3/wave-4 cutover). */
export const METAFACTORY_DIRNAME = "metafactory";
/** The canonical config directory name (now nested under `metafactory/`). */
export const CORTEX_CONFIG_DIRNAME = "cortex";
/** The legacy grove config directory name (read-fallback only during transition). */
export const GROVE_CONFIG_DIRNAME = "grove";

/** Which directory a resolved path came from. */
export type ConfigSource = "cortex" | "legacy-cortex" | "grove" | "default";

export interface ResolvedConfigFile {
  /** Absolute path to use. */
  path: string;
  /**
   * Where it resolved:
   *  - `cortex`        — the canonical `metafactory/cortex` file exists.
   *  - `legacy-cortex` — only the legacy flat `~/.config/cortex` file exists.
   *  - `grove`         — only the legacy `~/.config/grove` file exists.
   *  - `default`       — none exist; `path` is the canonical write target.
   */
  source: ConfigSource;
}

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? "~";
}

/** Legacy flat cortex config dir `~/.config/cortex` (read-fallback only). */
export function legacyCortexConfigDir(home?: string): string {
  return join(homeDir(home), ".config", CORTEX_CONFIG_DIRNAME);
}

/** Build `~/.config/cortex/<filename>` (legacy flat cortex tree / fallback). */
export function legacyCortexConfigPath(filename: string, home?: string): string {
  return join(legacyCortexConfigDir(home), filename);
}

/**
 * The `CORTEX_CONFIG_DIR` override, or `undefined` when unset/empty.
 *
 * When set it is the config directory verbatim (an absolute or relative path
 * the caller controls) — it wins over both the `~/.config/cortex` default and
 * any `home` test override. An empty string is treated as unset so a caller
 * that exports `CORTEX_CONFIG_DIR=` (blank) gets today's behavior, not `/`.
 */
export function cortexConfigDirOverride(): string | undefined {
  // Shared with `eventsDirOverride` via `readDirEnv` (PR#1920 nit b): trims,
  // and a blank/whitespace-only value reads as unset (not a literal relative
  // dir), so `CORTEX_CONFIG_DIR=` and `CORTEX_CONFIG_DIR="  "` keep today's
  // `~/.config/cortex` default.
  return readDirEnv("CORTEX_CONFIG_DIR");
}

/**
 * The cortex config DIRECTORY: `$CORTEX_CONFIG_DIR` if set, else the canonical
 * `~/.config/metafactory/cortex` (XDG wave-4, cortex#1869). This is the single
 * seam every config-file path is built on, so overriding the env var relocates
 * the whole config tree at once. The two pre-move trees (`~/.config/cortex`,
 * `~/.config/grove`) are read-fallbacks only — see {@link resolveConfigFile}.
 */
export function cortexConfigDir(home?: string): string {
  return (
    cortexConfigDirOverride() ??
    join(homeDir(home), ".config", METAFACTORY_DIRNAME, CORTEX_CONFIG_DIRNAME)
  );
}

/** Build `~/.config/cortex/<filename>` (canonical, or under `$CORTEX_CONFIG_DIR`). */
export function cortexConfigPath(filename: string, home?: string): string {
  return join(cortexConfigDir(home), filename);
}

/** Build `~/.config/grove/<filename>` (legacy / fallback). */
export function groveConfigPath(filename: string, home?: string): string {
  return join(homeDir(home), ".config", GROVE_CONFIG_DIRNAME, filename);
}

/**
 * Resolve a config FILE with cortex-first / grove-fallback precedence.
 *
 * Never throws on a missing file: when neither copy exists it returns the
 * cortex path with `source: "default"` so a caller writing a fresh config
 * lands it cortex-side.
 *
 * @param filename Bare filename under the config dir, e.g. `"cli.yaml"`.
 * @param home Override for `$HOME` (tests). Defaults to `process.env.HOME`.
 */
export function resolveConfigFile(filename: string, home?: string): ResolvedConfigFile {
  const cortex = cortexConfigPath(filename, home);
  if (existsSync(cortex)) return { path: cortex, source: "cortex" };

  // With an explicit `CORTEX_CONFIG_DIR` BOTH legacy read-fallbacks are SKIPPED:
  // the override is a self-contained config root, and probing the real
  // `~/.config/{cortex,grove}` would both break hermeticity (a real-home stat)
  // and be meaningless (the legacy trees have no counterpart under the root).
  if (cortexConfigDirOverride() === undefined) {
    // Fallback 1 — legacy flat `~/.config/cortex` (the pre-wave-4 canonical).
    const legacyCortex = legacyCortexConfigPath(filename, home);
    if (existsSync(legacyCortex)) {
      noteXdgFallback("config", `${filename} resolved from legacy ~/.config/cortex`);
      return { path: legacyCortex, source: "legacy-cortex" };
    }
    // Fallback 2 — legacy `~/.config/grove` (oldest tree; #1908 kept this).
    const grove = groveConfigPath(filename, home);
    if (existsSync(grove)) {
      // Under CORTEX_XDG_STRICT this emits the one grep-able `xdg-fallback:`
      // line the #1870 guard asserts ZERO of on a fresh install; non-strict
      // stays silent/byte-identical.
      noteXdgFallback("config", `${filename} resolved from legacy ~/.config/grove`);
      return { path: grove, source: "grove" };
    }
  }

  return { path: cortex, source: "default" };
}

/**
 * Convenience: the path to READ a config file from (cortex if present, else
 * grove if present, else the cortex path which a caller will find absent).
 */
export function resolveConfigFilePath(filename: string, home?: string): string {
  return resolveConfigFile(filename, home).path;
}

/**
 * Resolve the config DIRECTORY a CLI should read from during the transition:
 * the canonical `~/.config/metafactory/cortex` if it exists, else the legacy
 * flat `~/.config/cortex`, else `~/.config/grove`, else the canonical path (the
 * write target on a fresh host). This is the DIR analogue of
 * {@link resolveConfigFilePath} and is what the swept `DEFAULT_CONFIG_DIR`
 * defaults route through, so a command run BEFORE the config move still reads
 * the legacy tree (byte-identical to pre-wave-4) while a migrated host reads the
 * canonical tree. An explicit `$CORTEX_CONFIG_DIR` short-circuits all fallback.
 *
 * @param home Override for `$HOME` (tests). Resolved at CALL time so a
 *   command test that plants a fixture after import is honored.
 */
export function resolveConfigDir(home?: string): string {
  const canonical = cortexConfigDir(home);
  // An explicit override is a self-contained root — never probe legacy trees.
  if (cortexConfigDirOverride() !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;

  const legacyCortex = legacyCortexConfigDir(home);
  if (existsSync(legacyCortex)) {
    noteXdgFallback("config", "config dir resolved from legacy ~/.config/cortex");  // xdg-audit:allow(resolver legacy-fallback note — by design)
    return legacyCortex;
  }
  const grove = dirname(groveConfigPath("_", home));
  if (existsSync(grove)) {
    noteXdgFallback("config", "config dir resolved from legacy ~/.config/grove");  // xdg-audit:allow(resolver legacy-fallback note — by design)
    return grove;
  }
  return canonical;
}

/**
 * Auto-migrate a legacy-tree config FILE to its canonical location,
 * **preserving the file mode**. (Historically grove-only; XDG wave-4 widened
 * it to also carry the legacy flat `~/.config/cortex` tree into the canonical
 * `~/.config/metafactory/cortex`.)
 *
 * Precedence when both legacy copies exist: the flat `~/.config/cortex` copy is
 * newer than grove, so it wins (cortex-wins-on-dup, matching the merge policy).
 *
 * Idempotent and non-destructive:
 *   - if the canonical copy already exists → no-op, returns `false` (canonical
 *     is authoritative; we never clobber it with a stale legacy copy);
 *   - if only a legacy copy exists → copies it to canonical with the SAME mode
 *     (so a `chmod 600` secret such as `cloud-credentials.txt` stays 600 and
 *     is never widened), returns `true`;
 *   - if none exist → no-op, returns `false`.
 *
 * Mode preservation is explicit: `copyFileSync` does NOT preserve mode (the
 * destination is created with the process umask), so we re-apply the source
 * mode bits with `chmodSync`.
 *
 * @returns whether a migration copy was performed.
 */
export function migrateGroveConfigFile(filename: string, home?: string): boolean {
  const canonical = cortexConfigPath(filename, home);
  if (existsSync(canonical)) return false; // canonical copy is authoritative — never clobber

  // An explicit `CORTEX_CONFIG_DIR` root has no legacy side — never reach into
  // the real `~/.config/{cortex,grove}` to migrate (breaks the hermetic guard).
  if (cortexConfigDirOverride() !== undefined) return false;

  // cortex-wins-on-dup: prefer the newer flat `~/.config/cortex` copy, else grove.
  const legacyCortex = legacyCortexConfigPath(filename, home);
  const grove = groveConfigPath(filename, home);
  const src = existsSync(legacyCortex)
    ? { path: legacyCortex, tree: "~/.config/cortex" }  // xdg-audit:allow(resolver legacy-fallback candidate — by design)
    : existsSync(grove)
      ? { path: grove, tree: "~/.config/grove" }  // xdg-audit:allow(resolver legacy-fallback candidate — by design)
      : undefined;
  if (src === undefined) return false; // nothing to migrate

  // A migration copy IS a legacy-tree read — surface it under strict mode too.
  noteXdgFallback("config", `${filename} migrated from legacy ${src.tree}`);
  const mode = statSync(src.path).mode & 0o777;
  mkdirSync(dirname(canonical), { recursive: true });
  copyFileSync(src.path, canonical);
  // copyFileSync applies the umask, not the source mode — re-assert it so a
  // 0o600 secret is preserved exactly (and never widened) on the canonical copy.
  if (process.platform !== "win32") chmodSync(canonical, mode);
  return true;
}
