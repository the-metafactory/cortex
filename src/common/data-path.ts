/**
 * XDG wave-5 (cortex#1902, EPIC cortex#1867 §P3b) — DATA-dir path resolver.
 *
 * The metafactory DATA tree (Mission-Control dbs, the MC hook cursor, the
 * published-events buffer) is moving to the canonical XDG data root
 * `~/.local/share/metafactory/cortex/`, folded under the shared `metafactory`
 * root (matching the wave-3 `~/.local/bin` and wave-4 `~/.config/metafactory`
 * cutovers). Before this wave three MC-db layouts coexisted:
 *
 *   1. `~/.local/share/grove/mission-control.db`      — standalone MC v2 default.
 *   2. `~/.local/share/cortex/mc/<stack>/…`           — per-stack embedded default.
 *   3. sibling-db-reader discovered peers BY the #2 shape.
 *
 * This module is the single seam that resolves a DATA path with
 * **canonical-first / legacy-fallback** precedence during the transition, so a
 * pre-cutover box still reads the old tree while a migrated box reads the new
 * one. It is the DATA analogue of `config/config-path.ts`.
 *
 * ── Precedence (read) ────────────────────────────────────────────────────────
 *   1. `$CORTEX_DATA_DIR/<…>`                          — explicit override (verbatim,
 *      a self-contained root; NO legacy probe — mirrors the config seam).
 *   2. `~/.local/share/metafactory/cortex/<…>`         — canonical (used if present).
 *   3. legacy tree (`~/.local/share/cortex/…` or grove) — read-fallback if present.
 *   4. canonical path                                  — write/default target when none.
 *
 * ── Two resolution flavours ──────────────────────────────────────────────────
 * The SERVING stack migrates its OWN db on boot (see `migrate-data-dir.ts`), so
 * it resolves-and-migrates. The sibling reader only READS peers' dbs — it must
 * NEVER migrate another stack's data — so it uses the PURE existence-gated
 * resolvers here (no side effects beyond `existsSync`). Both share this module
 * so the on-disk shape they compute is byte-identical (self-exclusion depends on
 * it).
 *
 * Every legacy-tree hit is surfaced via {@link noteXdgFallback} so a
 * `CORTEX_XDG_STRICT=1` fresh-install run stays silent (Fallback Contract,
 * cortex#1867). Isolation: every path derives from an injectable `home`, so the
 * whole seam runs against a scratch `$HOME` with ZERO real-home access.
 */

import { existsSync } from "fs";
import { join } from "path";

import { noteXdgFallback, readDirEnv } from "./xdg";

/** The shared metafactory XDG root under `~/.local/share` (wave-5 cutover). */
export const METAFACTORY_DIRNAME = "metafactory";
/** The canonical data directory name (nested under `metafactory/`). */
export const CORTEX_DATA_DIRNAME = "cortex";
/** The legacy grove data directory name (read-fallback only during transition). */
export const GROVE_DATA_DIRNAME = "grove";
/** Bare filename of the MC hook cursor (G-25). */
export const MC_HOOK_CURSOR_NAME = "mc-hook-cursor.json";
/** Bare filename of a standalone MC v2 db. */
export const MISSION_CONTROL_DB_NAME = "mission-control.db";

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? "~";
}

/**
 * The `CORTEX_DATA_DIR` override, or `undefined` when unset/empty. A blank or
 * whitespace-only value reads as unset (via {@link readDirEnv}) so
 * `CORTEX_DATA_DIR=` keeps today's `~/.local/share/…` default rather than
 * resolving to `/`. When set it is the data root VERBATIM and both legacy
 * fallbacks are skipped (a self-contained root has no legacy counterpart, and
 * probing the real `~/.local/share/{cortex,grove}` would break hermeticity).
 */
export function cortexDataDirOverride(): string | undefined {
  return readDirEnv("CORTEX_DATA_DIR");
}

/**
 * The cortex DATA directory: `$CORTEX_DATA_DIR` if set, else the canonical
 * `~/.local/share/metafactory/cortex` (XDG wave-5). This is the single seam
 * every data path is built on, so overriding the env var relocates the whole
 * data tree at once.
 */
export function cortexDataDir(home?: string): string {
  return (
    cortexDataDirOverride() ??
    join(homeDir(home), ".local", "share", METAFACTORY_DIRNAME, CORTEX_DATA_DIRNAME)
  );
}

/** Legacy flat cortex data dir `~/.local/share/cortex` (read-fallback only). */
export function legacyCortexDataDir(home?: string): string {
  return join(homeDir(home), ".local", "share", CORTEX_DATA_DIRNAME);
}

/** Legacy grove data dir `~/.local/share/grove` (oldest tree; read-fallback only). */
export function legacyGroveDataDir(home?: string): string {
  return join(homeDir(home), ".local", "share", GROVE_DATA_DIRNAME);
}

// ───────────────────────────────────────────────────── per-stack MC db (layout 2/3)

/** Canonical per-stack MC db root: `~/.local/share/metafactory/cortex/mc`. */
export function mcDbRoot(home?: string): string {
  return join(cortexDataDir(home), "mc");
}

/** Legacy per-stack MC db root: `~/.local/share/cortex/mc` (pre-wave-5). */
export function legacyMcDbRoot(home?: string): string {
  return join(legacyCortexDataDir(home), "mc");
}

/** Canonical per-stack MC db path (write/default target). */
export function canonicalStackDbPath(stack: string, home?: string): string {
  return join(mcDbRoot(home), stack, MISSION_CONTROL_DB_NAME);
}

/** Legacy per-stack MC db path (`~/.local/share/cortex/mc/<stack>/…`). */
export function legacyStackDbPath(stack: string, home?: string): string {
  return join(legacyMcDbRoot(home), stack, MISSION_CONTROL_DB_NAME);
}

/**
 * PURE existence-gated resolution of a per-stack MC db path — NO side effects
 * beyond `existsSync`. Prefers the canonical location if present, else the
 * legacy `~/.local/share/cortex/mc/<stack>/…` if present, else the canonical
 * path (the write target on a fresh host). An explicit `$CORTEX_DATA_DIR`
 * short-circuits all fallback (self-contained root).
 *
 * This is what the sibling-db-reader uses to resolve PEERS' dbs — it reads them
 * read-only and must NEVER migrate another stack's data, so a peer that has
 * migrated is read from the new tree and one that has not is read from legacy.
 * The serving stack's OWN db is resolved-and-migrated by `migrate-data-dir.ts`
 * (which then lands here at the canonical path).
 */
export function resolveStackDbPath(stack: string, home?: string): string {
  const canonical = canonicalStackDbPath(stack, home);
  if (cortexDataDirOverride() !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;
  const legacy = legacyStackDbPath(stack, home);
  if (existsSync(legacy)) {
    noteXdgFallback("data", `mc db for "${stack}" resolved from legacy ~/.local/share/cortex/mc`);  // xdg-audit:allow(resolver legacy-fallback note — by design)
    return legacy;
  }
  return canonical;
}

// ─────────────────────────────────────────────────── standalone MC v2 db (layout 1)

/** Canonical standalone MC v2 db path: `~/.local/share/metafactory/cortex/mission-control.db`. */
export function canonicalStandaloneDbPath(home?: string): string {
  return join(cortexDataDir(home), MISSION_CONTROL_DB_NAME);
}

/** Legacy standalone MC v2 db path: `~/.local/share/grove/mission-control.db`. */
export function legacyStandaloneDbPath(home?: string): string {
  return join(legacyGroveDataDir(home), MISSION_CONTROL_DB_NAME);
}

/**
 * PURE existence-gated resolution of the standalone MC v2 db path. Prefers the
 * canonical location if present, else the legacy `~/.local/share/grove/…` if
 * present, else the canonical path. `$CORTEX_DATA_DIR` short-circuits fallback.
 */
export function resolveStandaloneDbPath(home?: string): string {
  const canonical = canonicalStandaloneDbPath(home);
  if (cortexDataDirOverride() !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;
  const legacy = legacyStandaloneDbPath(home);
  if (existsSync(legacy)) {
    noteXdgFallback("data", "mission-control.db resolved from legacy ~/.local/share/grove");  // xdg-audit:allow(resolver legacy-fallback note — by design)
    return legacy;
  }
  return canonical;
}

// ─────────────────────────────────────────────────────── MC hook cursor (G-25)

/** Canonical MC hook cursor path: `~/.local/share/metafactory/cortex/mc-hook-cursor.json`. */
export function canonicalCursorPath(home?: string): string {
  return join(cortexDataDir(home), MC_HOOK_CURSOR_NAME);
}

/** Legacy MC hook cursor path: `~/.local/share/grove/mc-hook-cursor.json`. */
export function legacyCursorPath(home?: string): string {
  return join(legacyGroveDataDir(home), MC_HOOK_CURSOR_NAME);
}

/**
 * PURE existence-gated resolution of the MC hook cursor path. Prefers canonical,
 * else legacy grove, else canonical. `$CORTEX_DATA_DIR` short-circuits fallback.
 */
export function resolveCursorPath(home?: string): string {
  const canonical = canonicalCursorPath(home);
  if (cortexDataDirOverride() !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;
  const legacy = legacyCursorPath(home);
  if (existsSync(legacy)) {
    noteXdgFallback("data", "mc-hook-cursor.json resolved from legacy ~/.local/share/grove");  // xdg-audit:allow(resolver legacy-fallback note — by design)
    return legacy;
  }
  return canonical;
}

// ──────────────────────────────────────────────── published-events buffer (AC2/AC3)

/**
 * Canonical published-events buffer: `~/.local/share/metafactory/cortex/events/published`.
 * This is the DATA half of the cc-events buffer that #1902 moves under the data
 * root (events-path.ts's scope note assigns the buffer move here). The RAW half
 * stays at `~/.claude/events/raw` (Claude Code hook territory); only `published`
 * — cortex's own durable archive — relocates.
 */
export function canonicalPublishedEventsDir(home?: string): string {
  return join(cortexDataDir(home), "events", "published");
}

/** Legacy published-events buffer: `~/.claude/events/published`. */
export function legacyPublishedEventsDir(home?: string): string {
  return join(homeDir(home), ".claude", "events", "published");
}

/**
 * PURE existence-gated resolution of the published-events dir. Prefers the
 * canonical data-root location if present, else the legacy `~/.claude/events/
 * published` if present, else the canonical path. `$CORTEX_DATA_DIR`
 * short-circuits fallback. Writer (relay) and reader (outbound-log) both route
 * through this so they stay in lockstep after the move.
 */
export function resolvePublishedEventsDir(home?: string): string {
  const canonical = canonicalPublishedEventsDir(home);
  if (cortexDataDirOverride() !== undefined) return canonical;
  if (existsSync(canonical)) return canonical;
  const legacy = legacyPublishedEventsDir(home);
  if (existsSync(legacy)) {
    noteXdgFallback("data", "published events resolved from legacy ~/.claude/events/published");  // xdg-audit:allow(resolver legacy-fallback note — by design)
    return legacy;
  }
  return canonical;
}

/**
 * The canonical STRING literal written into a generated `cortex.yaml` and used
 * as the zod default for `paths.publishedEventsDir`. Uses the `~`-prefixed
 * spelling (matching the pre-move `~/.claude/events/published` default and the
 * consumer's `replace(/^~/, HOME)` expansion) so the persisted config stays
 * home-relative and portable.
 */
export const PUBLISHED_EVENTS_DIR_DEFAULT =
  "~/.local/share/metafactory/cortex/events/published";

/** The pre-move default literal for `paths.publishedEventsDir` (value-migrator source). */
export const LEGACY_PUBLISHED_EVENTS_DIR_DEFAULT = "~/.claude/events/published";  // xdg-audit:allow(resolver legacy-fallback constant — by design)

// ────────────────────────────────────────────────── per-stack workspace dir (cortex#2097)

/**
 * Canonical per-stack workspace dir: `~/.local/share/metafactory/cortex/<slug>/workspace`.
 *
 * The dispatch cwd FALLBACK for a bare stack (no `allowedDirs`/`dirRestrictions`
 * configured) — see `dispatch-handler.ts` G-500. Before this, an unconfigured
 * stack's dispatched CC session inherited the DAEMON's own cwd: `$HOME` on a
 * Linux systemd unit with no `WorkingDirectory=` (community #cortex thread,
 * 2026-07-16 — visible as `~/.claude/projects/-home-<user>/`), or the cortex
 * install repo itself on the macOS launchd plist. Both silently widen the
 * assistant's read/write scope to somewhere it must never be. Slug-scoped
 * (not a flat shared dir) so co-hosted stacks never share one workspace.
 *
 * No legacy-fallback probe (unlike the sibling resolvers in this module) —
 * this is a net-new concept with no prior on-disk location to migrate from.
 */
export function canonicalWorkspaceDir(slug: string, home?: string): string {
  return join(cortexDataDir(home), slug, "workspace");
}
