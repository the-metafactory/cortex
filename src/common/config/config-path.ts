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
 * `~/.config/cortex` default is bypassed), so a hermetic guard (#1870) can
 * point config resolution at a scratch dir with ZERO real-home access. When
 * UNSET, every path here is byte-identical to before. This is JUST the env
 * read; honoring `$XDG_CONFIG_HOME` and moving files is #1869/#1903 — out of
 * scope. `CORTEX_STATE_DIR` (the `pidfile.ts` state dir) is owned by #1900
 * this wave (G-21 serialization); `CORTEX_EVENTS_DIR` lives in `events-path.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, chmodSync } from "fs";
import { dirname, join } from "path";

/** The canonical config directory name. */
export const CORTEX_CONFIG_DIRNAME = "cortex";
/** The legacy config directory name (read-fallback only during transition). */
export const GROVE_CONFIG_DIRNAME = "grove";

/** Which directory a resolved path came from. */
export type ConfigSource = "cortex" | "grove" | "default";

export interface ResolvedConfigFile {
  /** Absolute path to use. */
  path: string;
  /**
   * Where it resolved:
   *  - `cortex`  — the canonical file exists.
   *  - `grove`   — only the legacy file exists (fallback in effect).
   *  - `default` — neither exists; `path` is the cortex write target.
   */
  source: ConfigSource;
}

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? "~";
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
  const v = process.env.CORTEX_CONFIG_DIR;
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * The cortex config DIRECTORY: `$CORTEX_CONFIG_DIR` if set, else the canonical
 * `~/.config/cortex`. This is the single seam every config-file path is built
 * on, so overriding the env var relocates the whole config tree at once.
 */
export function cortexConfigDir(home?: string): string {
  return cortexConfigDirOverride() ?? join(homeDir(home), ".config", CORTEX_CONFIG_DIRNAME);
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

  // With an explicit `CORTEX_CONFIG_DIR` the legacy grove read-fallback is
  // SKIPPED: the override is a self-contained config root, and probing the
  // real `~/.config/grove` would both break hermeticity (a real-home stat)
  // and be meaningless (grove has no counterpart under an explicit root).
  if (cortexConfigDirOverride() === undefined) {
    const grove = groveConfigPath(filename, home);
    if (existsSync(grove)) return { path: grove, source: "grove" };
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
 * Auto-migrate a legacy grove-side config FILE to its cortex location,
 * **preserving the file mode**.
 *
 * Idempotent and non-destructive:
 *   - if the cortex copy already exists → no-op, returns `false` (the cortex
 *     copy is canonical; we never clobber it with a stale grove copy);
 *   - if only the grove copy exists → copies it to cortex with the SAME mode
 *     (so a `chmod 600` secret such as `cloud-credentials.txt` stays 600 and
 *     is never widened), returns `true`;
 *   - if neither exists → no-op, returns `false`.
 *
 * Mode preservation is explicit: `copyFileSync` does NOT preserve mode (the
 * destination is created with the process umask), so we re-apply the source
 * mode bits with `chmodSync`.
 *
 * @returns whether a migration copy was performed.
 */
export function migrateGroveConfigFile(filename: string, home?: string): boolean {
  const cortex = cortexConfigPath(filename, home);
  if (existsSync(cortex)) return false; // cortex copy is canonical — never clobber

  // An explicit `CORTEX_CONFIG_DIR` root has no grove side — never reach into
  // the real `~/.config/grove` to migrate (would break the hermetic guard).
  if (cortexConfigDirOverride() !== undefined) return false;

  const grove = groveConfigPath(filename, home);
  if (!existsSync(grove)) return false; // nothing to migrate

  const mode = statSync(grove).mode & 0o777;
  mkdirSync(dirname(cortex), { recursive: true });
  copyFileSync(grove, cortex);
  // copyFileSync applies the umask, not the source mode — re-assert it so a
  // 0o600 secret is preserved exactly (and never widened) on the cortex copy.
  if (process.platform !== "win32") chmodSync(cortex, mode);
  return true;
}
