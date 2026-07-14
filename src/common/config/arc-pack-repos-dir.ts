/**
 * arc-pack-repos-dir — existence-gated resolver for ARC's package-repos
 * DIRECTORY, mirroring arc's own `dataRoot/repos` resolution (cortex#1988,
 * EPIC cortex#1867).
 *
 * WHY THIS EXISTS — the runtime miss it closes:
 *
 * cortex boots exec-brain (Bot Pack) agents from packs that ARC installs on
 * disk. cortex locates a pack at `{brainPackBaseDir}/{agentId}`
 * (`src/runner/brain-consumer-boot.ts` → `join(opts.brainPackBaseDir, agent.id)`).
 * Before this module, `cortex.ts` hardcoded that base as
 * `~/.config/metafactory/pkg/repos` — arc's PRE-#287 default. arc#287 (arc's
 * XDG own-dirs wave) moved arc's canonical package-repos dir to the DATA class
 * root: `$XDG_DATA_HOME ?? ~/.local/share` → `metafactory/arc/repos`
 * (`arc/src/lib/paths.ts` `reposDir`, multi-tree default layout). The old
 * `~/.config/metafactory/pkg/repos` now survives ONLY as arc's `singleTree`
 * fallback (an `ARC_CONFIG_ROOT` / override install). On a default MIGRATED box
 * cortex was reading an empty/stale legacy tree → exec-brain packs failed to
 * resolve at boot.
 *
 * So cortex MUST resolve arc's package-repos dir the SAME way arc does, and
 * always read where arc writes. This module is the single source of that
 * resolution — the REVERSE of `arc/src/lib/hosts/cortex-config-dir.ts` (arc
 * mirroring cortex's config resolver). It byte-mirrors arc's `dataDir("arc")`
 * (`arc/src/lib/xdg-paths.ts`) plus the `/repos` tail:
 *
 *   canonical = (`$XDG_DATA_HOME` ?? `~/.local/share`) / `metafactory` / `arc` / `repos`
 *
 * Precedence (read):
 *   1. canonical (XDG-honoring) — if it exists (a default / migrated box).
 *   2. legacy `~/.config/metafactory/pkg/repos` — ONLY if it exists
 *      (existence-gated, so an `ARC_CONFIG_ROOT` / singleTree install that keeps
 *      the pre-#287 tree still resolves).
 *   3. canonical — the default target when neither exists (a fresh host reads
 *      the XDG-canonical tree, never the legacy one).
 *
 * DELIBERATELY existence-gated rather than a bare canonical-string swap: a bare
 * swap re-drifts on the next arc paths change and silently breaks singleTree
 * installs. This resolver tracks arc's DATA-class layout AND keeps legacy
 * installs resolving.
 *
 * SCOPE — this only RESOLVES arc's repos dir for READ; it never creates,
 * migrates, or writes it. arc owns that tree and its migration (#287). cortex
 * reads it.
 *
 * The `{home, env}` seam is injectable for hermetic tests (never touch the real
 * `~/.local/share` or `~/.config`). It mirrors arc's `XdgSeam` `{home, env}`.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

/** The shared metafactory XDG suite namespace (matches arc's `SUITE`). */
export const METAFACTORY_DIRNAME = "metafactory";
/** arc's XDG app namespace — every arc XDG root resolves under `metafactory/arc`. */
export const ARC_APP_DIRNAME = "arc";
/** The repos-dir tail arc appends under its data root (`dataRoot/repos`). */
export const ARC_REPOS_DIRNAME = "repos";

/**
 * Injectable `{home, env}` seam for hermetic tests. Both default to the real
 * process environment when omitted — mirroring arc's `XdgSeam` `{home, env}`.
 */
export interface ArcPackReposDirSeam {
  /** Injectable `$HOME`. Defaults to `os.homedir()`. */
  home?: string;
  /** Injectable environment. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function seamHome(seam?: ArcPackReposDirSeam): string {
  return seam?.home ?? homedir();
}

function seamEnv(seam?: ArcPackReposDirSeam): Record<string, string | undefined> {
  return seam?.env ?? process.env;
}

/**
 * Expand a leading `~` (and only a leading `~`) to `home`, then strip trailing
 * separators (but never collapse `/` itself). Mirrors arc's `xdg-paths.ts`
 * `normalizePath` (Windows-aware superset; identical for POSIX input).
 */
function normalizePath(path: string, home: string): string {
  const expanded = path === "~" ? home : path.replace(/^~(?=[/\\])/, home);
  return expanded === "/" ? expanded : expanded.replace(/[/\\]+$/, "");
}

/**
 * arc's CANONICAL package-repos dir, byte-mirroring `arc/src/lib/paths.ts`
 * `reposDir` on the default (multi-tree) layout = `dataDir("arc")/repos`:
 *
 *   (`$XDG_DATA_HOME` ?? `~/.local/share`) / `metafactory` / `arc` / `repos`
 *
 * `$XDG_DATA_HOME` is trimmed; a blank/whitespace-only value reads as unset
 * (matching arc's `raw?.trim()` truthiness check), never a literal relative dir.
 */
export function arcCanonicalPackReposDir(seam?: ArcPackReposDirSeam): string {
  const home = seamHome(seam);
  const raw = seamEnv(seam).XDG_DATA_HOME?.trim();
  const base = raw ? normalizePath(raw, home) : join(home, ".local", "share");
  return join(base, METAFACTORY_DIRNAME, ARC_APP_DIRNAME, ARC_REPOS_DIRNAME);
}

/**
 * arc's LEGACY (pre-#287) package-repos dir `~/.config/metafactory/pkg/repos` —
 * the path an `ARC_CONFIG_ROOT` / singleTree install still uses. Read-fallback
 * only, existence-gated in {@link resolveArcPackReposDir}.
 */
export function legacyArcPackReposDir(seam?: ArcPackReposDirSeam): string {
  return join(seamHome(seam), ".config", METAFACTORY_DIRNAME, "pkg", ARC_REPOS_DIRNAME);
}

/**
 * Resolve arc's package-repos DIRECTORY, existence-gated, mirroring arc's
 * `dataRoot/repos` resolution (see file header). The XDG-canonical tree wins if
 * it exists (a default / migrated box), else the legacy
 * `~/.config/metafactory/pkg/repos` tree if it exists (singleTree / override
 * install), else the canonical path as the fresh-host default.
 *
 * cortex routes the DEFAULT `brainPackBaseDir` (when no explicit
 * `options.brainPackBaseDir` override is set) through this so exec-brain packs
 * resolve where arc actually installed them — canonical on a migrated box,
 * legacy on a singleTree install.
 */
export function resolveArcPackReposDir(seam?: ArcPackReposDirSeam): string {
  const canonical = arcCanonicalPackReposDir(seam);
  if (existsSync(canonical)) return canonical;

  const legacy = legacyArcPackReposDir(seam);
  if (existsSync(legacy)) return legacy;

  return canonical;
}

/**
 * Resolve the on-disk path to a file (typically a workflow script) INSIDE an
 * arc-installed pack, rooted at the existence-gated {@link resolveArcPackReposDir}.
 * The pack name plus any trailing path `segments` are joined onto the resolved
 * repos dir:
 *
 *   arcPackScriptPath("agent-state", ["skill", "scripts", "scaffold.ts"])
 *     → <reposDir>/agent-state/skill/scripts/scaffold.ts
 *
 * This is the SINGLE construction site for arc-pack script paths across cortex —
 * the agent-state scaffold/errands resolvers and the deploy confidentiality-scan
 * engine path all route through it (cortex#2007), so the pre-#287
 * `~/.config/metafactory/pkg/repos` default can never be re-hardcoded per-caller
 * (the #1988 bug class — it had already shipped three times via a triplicated
 * `defaultErrandsScript`).
 *
 * Resolved PER CALL (never frozen): a late `$HOME` / `$XDG_DATA_HOME` change — or
 * arc installing the pack AFTER cortex boot — is honoured, matching the lazy
 * `opts ?? DEFAULT` semantics of the resolvers that consume it. The `{home, env}`
 * seam flows straight through to the repos-dir resolver for hermetic tests.
 */
export function arcPackScriptPath(
  pack: string,
  segments: string[],
  seam?: ArcPackReposDirSeam,
): string {
  return join(resolveArcPackReposDir(seam), pack, ...segments);
}
