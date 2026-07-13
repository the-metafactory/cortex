/**
 * XDG wave-5 (cortex#1903, EPIC cortex#1867 §P3c) — STATE-dir path resolver.
 *
 * The metafactory STATE tree (daemon pidfiles + degraded-state markers, rotating
 * logs, the relay pidfile, and the DD-10 signature-verified network-cache) is
 * moving to the canonical XDG state root `~/.local/state/metafactory/cortex/`,
 * folded under the shared `metafactory` root (matching the wave-3 `~/.local/bin`,
 * wave-4 `~/.config/metafactory`, and wave-5 `~/.local/share/metafactory` moves).
 * Before this wave the four state classes lived in three legacy locations:
 *
 *   1. pidfiles + `.degraded.json` markers → `~/.config/grove/state/`   (pidfile.ts).
 *   2. rotating logs                       → `~/.config/grove/logs/` AND
 *                                             `~/.config/cortex/logs/`   (two schema
 *                                             defaults; both are read-fallbacks).
 *   3. relay pidfile                        → `~/.claude/relay/relay.pid` (relay.ts).
 *   4. network-cache (DD-10 last-known-good roster) → `~/.config/cortex/network-cache/`.
 *
 * This module is the single seam that resolves each STATE path with
 * **canonical-first / legacy-fallback** precedence during the transition, so a
 * pre-cutover box still reads the old tree while a migrated box reads the new
 * one. It is the STATE analogue of `data-path.ts` / `config/config-path.ts`.
 *
 * ── network-cache is STATE, not cache (§1.2, DD-10) ──────────────────────────
 * The `network-cache` dir holds the last verified descriptor + roster the stack
 * falls back to when the registry is unreachable at boot (the offline-fallback
 * roster). It is DURABLE trust state — NOT a regenerable cache — so it moves to
 * the state root, and its move is gated + copy-keep-source like the pidfiles.
 *
 * ── Precedence (read) ────────────────────────────────────────────────────────
 *   1. `$CORTEX_STATE_DIR/<…>`                     — explicit override (VERBATIM,
 *      a self-contained root; NO legacy probe — mirrors the config/data seams).
 *   2. `~/.local/state/metafactory/cortex/<…>`     — canonical (used if present).
 *   3. legacy tree (grove state/logs, cortex logs/network-cache, claude relay)
 *      — read-fallback if present.
 *   4. canonical path                              — write/default target when none.
 *
 * ── The STATE_DIR module-const hazard (T1b / cortex#1900) ────────────────────
 * `pidfile.ts` bakes `STATE_DIR` at import from {@link resolvePidStateDir}. A
 * RUNNING daemon computed its pidfile path from whatever STATE_DIR resolved to at
 * ITS import; a later CLI that resolves a DIFFERENT dir would compute a different
 * pidfile name and fail to find/manage the daemon. This is contained because the
 * physical state MOVE is GATED (X-09): nothing is running during the migration,
 * so no daemon's pidfile identity flips out from under it, and after the move +
 * restart every process resolves the canonical dir consistently.
 *
 * Every legacy-tree hit is surfaced via {@link noteXdgFallback} so a
 * `CORTEX_XDG_STRICT=1` fresh-install run stays silent (Fallback Contract,
 * cortex#1867). Isolation: every path derives from an injectable `home`, so the
 * whole seam runs against a scratch `$HOME` with ZERO real-home access.
 */

import { existsSync } from "fs";
import { join } from "path";

import { noteXdgFallback, readDirEnv } from "./xdg";

/** The shared metafactory XDG root name (nested under the state home). */
export const METAFACTORY_DIRNAME = "metafactory";
/** The canonical state directory name (nested under `metafactory/`). */
export const CORTEX_STATE_DIRNAME = "cortex";

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? "~";
}

/**
 * The XDG state home: `$XDG_STATE_HOME` if set (VERBATIM), else `~/.local/state`.
 * Mirrors the freedesktop XDG base-dir spec (the state analogue of
 * `$XDG_DATA_HOME` / `~/.local/share`). Read through {@link readDirEnv} so a
 * blank/whitespace value reads as unset rather than resolving to `/state`.
 */
export function xdgStateHome(home?: string): string {
  return readDirEnv("XDG_STATE_HOME") ?? join(homeDir(home), ".local", "state");
}

/**
 * The `CORTEX_STATE_DIR` override, or `undefined` when unset/empty. A blank or
 * whitespace-only value reads as unset (via {@link readDirEnv}) so
 * `CORTEX_STATE_DIR=` keeps the default rather than resolving to `/`. When set it
 * is the state root VERBATIM and ALL legacy fallbacks are skipped (a
 * self-contained root has no legacy counterpart, and probing the real
 * `~/.config/{grove,cortex}` / `~/.claude` would break hermeticity).
 *
 * NOTE: `pidfile.ts` reads `CORTEX_STATE_DIR` directly at import for its own
 * `STATE_DIR` const (cortex#1908 seam, kept for its no-heavy-import-graph rule);
 * this is the SAME env var, so the two never diverge — both trim + treat blank as
 * unset, and both resolve to the same canonical default when unset.
 */
export function cortexStateDirOverride(): string | undefined {
  return readDirEnv("CORTEX_STATE_DIR");
}

/**
 * The cortex STATE directory: `$CORTEX_STATE_DIR` if set, else the canonical
 * `$XDG_STATE_HOME/metafactory/cortex` (default `~/.local/state/metafactory/
 * cortex`). This is the single seam every state path is built on, so overriding
 * the env var relocates the whole state tree at once.
 */
export function cortexStateDir(home?: string): string {
  return (
    cortexStateDirOverride() ??
    join(xdgStateHome(home), METAFACTORY_DIRNAME, CORTEX_STATE_DIRNAME)
  );
}

// ─────────────────────────────────────────────────────── canonical sub-locations

/** Canonical pidfile + degraded-marker dir (the state root itself; pidfiles
 *  live directly under it, matching the legacy flat `~/.config/grove/state`). */
export function canonicalPidStateDir(home?: string): string {
  return cortexStateDir(home);
}

/** Canonical rotating-logs dir: `~/.local/state/metafactory/cortex/logs`. */
export function canonicalLogsDir(home?: string): string {
  return join(cortexStateDir(home), "logs");
}

/** Canonical relay dir (holds `relay.pid`): `…/metafactory/cortex/relay`. */
export function canonicalRelayDir(home?: string): string {
  return join(cortexStateDir(home), "relay");
}

/** Canonical DD-10 network-cache dir: `…/metafactory/cortex/network-cache`. */
export function canonicalNetworkCacheDir(home?: string): string {
  return join(cortexStateDir(home), "network-cache");
}

// ───────────────────────────────────────────────────────────── legacy locations

/** Legacy pidfile dir `~/.config/grove/state` (the pre-move pidfile.ts default). */
export function legacyPidStateDir(home?: string): string {
  return join(homeDir(home), ".config", "grove", "state");
}

/** Legacy grove logs dir `~/.config/grove/logs` (CortexConfigSchema default). */
export function legacyGroveLogsDir(home?: string): string {
  return join(homeDir(home), ".config", "grove", "logs");
}

/** Legacy cortex logs dir `~/.config/cortex/logs` (cortex-config PathsSchema default). */
export function legacyCortexLogsDir(home?: string): string {
  return join(homeDir(home), ".config", "cortex", "logs");
}

/** Legacy relay dir `~/.claude/relay` (holds `relay.pid`; also `relay-policy.yaml`
 *  which is CONFIG and stays — only the pidfile moves). */
export function legacyRelayDir(home?: string): string {
  return join(homeDir(home), ".claude", "relay");
}

/** Legacy DD-10 network-cache dir `~/.config/cortex/network-cache`. */
export function legacyNetworkCacheDir(home?: string): string {
  return join(homeDir(home), ".config", "cortex", "network-cache");
}

// ─────────────────────────────────────────────── existence-gated dir resolvers

/**
 * PURE existence-gated resolution of a state DIR — NO side effects beyond
 * `existsSync`. Prefers the canonical location if present, else the FIRST legacy
 * candidate that exists (in the given precedence order), else the canonical path
 * (the write target on a fresh host / post-migration). An explicit
 * `$CORTEX_STATE_DIR` short-circuits ALL fallback (self-contained root). Every
 * legacy hit is surfaced under `CORTEX_XDG_STRICT` via {@link noteXdgFallback}.
 */
function resolveStateSubdir(
  canonical: string,
  legacies: readonly { dir: string; note: string }[],
): string {
  if (cortexStateDirOverride() !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;
  for (const l of legacies) {
    if (existsSync(l.dir)) {
      noteXdgFallback("state", l.note);
      return l.dir;
    }
  }
  return canonical;
}

/** Resolve the pidfile + degraded-marker dir (canonical → legacy grove state). */
export function resolvePidStateDir(home?: string): string {
  return resolveStateSubdir(canonicalPidStateDir(home), [
    { dir: legacyPidStateDir(home), note: "pidfile dir resolved from legacy ~/.config/grove/state" },
  ]);
}

/** Resolve the logs dir (canonical → legacy grove logs → legacy cortex logs). */
export function resolveLogsDir(home?: string): string {
  return resolveStateSubdir(canonicalLogsDir(home), [
    { dir: legacyGroveLogsDir(home), note: "logs dir resolved from legacy ~/.config/grove/logs" },
    { dir: legacyCortexLogsDir(home), note: "logs dir resolved from legacy ~/.config/cortex/logs" },
  ]);
}

/** Resolve the relay dir (canonical → legacy ~/.claude/relay). */
export function resolveRelayDir(home?: string): string {
  return resolveStateSubdir(canonicalRelayDir(home), [
    { dir: legacyRelayDir(home), note: "relay pidfile dir resolved from legacy ~/.claude/relay" },
  ]);
}

/** Resolve the network-cache dir (canonical → legacy ~/.config/cortex/network-cache). */
export function resolveNetworkCacheDir(home?: string): string {
  return resolveStateSubdir(canonicalNetworkCacheDir(home), [
    {
      dir: legacyNetworkCacheDir(home),
      note: "network-cache resolved from legacy ~/.config/cortex/network-cache",
    },
  ]);
}

// ──────────────────────────────────────────────────── schema value defaults

/**
 * The canonical STRING literal for `paths.logDir` in the config schemas. Uses the
 * `~`-prefixed spelling (matching the pre-move `~/.config/grove/logs` default and
 * the `expandTilde` expansion at the consumer) so the persisted config stays
 * home-relative and portable. Kept in sync with the schema literals in
 * `types/config.ts` and `types/cortex-config.ts` (which do NOT import this
 * fs-touching module, mirroring `PUBLISHED_EVENTS_DIR_DEFAULT` in data-path.ts).
 */
export const LOG_DIR_DEFAULT = "~/.local/state/metafactory/cortex/logs";

/** Pre-move grove logDir default (value-migration / test source). */
export const LEGACY_LOG_DIR_DEFAULT_GROVE = "~/.config/grove/logs";
/** Pre-move cortex logDir default (value-migration / test source). */
export const LEGACY_LOG_DIR_DEFAULT_CORTEX = "~/.config/cortex/logs";
