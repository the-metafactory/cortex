/**
 * cortex#2007 — SHARED resolvers for the AgentState bundle's workflow scripts.
 *
 * Before this module the `scaffold.ts` / `errands.ts` default paths were
 * hand-built at FOUR call sites (agent-state-scaffold ×2, dispatch-state-recorder,
 * agent-state-dev-session-store) — three of them a byte-identical
 * `defaultErrandsScript()` copy. That triplication is exactly how the #1988 bug
 * class (a hardcoded pre-#287 `~/.config/metafactory/pkg/repos`) shipped three
 * times. Consolidating to ONE definition per script means the arc package-repos
 * dir is resolved in ONE place ({@link arcPackScriptPath} →
 * {@link resolveArcPackReposDir}) and can never re-drift per-caller.
 *
 * Precedence (highest first), preserved from the original per-call resolvers:
 *   1. the env override (`MF_AGENT_STATE_SCRIPT` / `MF_AGENT_STATE_ERRANDS_SCRIPT`)
 *      for a non-standard install;
 *   2. the arc-canonical pack path, existence-gated (canonical XDG tree on a
 *      migrated box, legacy `~/.config/metafactory/pkg/repos` on a singleTree
 *      install, canonical as the fresh-host default).
 *
 * Resolved PER CALL (never frozen at import) so a late env / `$HOME` /
 * `$XDG_DATA_HOME` change — or arc installing the bundle after cortex boot — is
 * honoured, matching the `opts ?? DEFAULT` pattern the consumers use. The
 * `{home, env}` seam is injectable for hermetic tests; the env override is read
 * from the SAME seam bag so a test never has to mutate `process.env`.
 */

import {
  arcPackScriptPath,
  type ArcPackReposDirSeam,
} from "../config/arc-pack-repos-dir";

/** arc pack that houses the AgentState bundle's workflow scripts. */
export const AGENT_STATE_PACK = "agent-state";
/** In-pack directory the bundle lays its workflow scripts under. */
const SKILL_SCRIPTS_SEGMENTS = ["skill", "scripts"] as const;

function seamEnv(seam?: ArcPackReposDirSeam): Record<string, string | undefined> {
  return seam?.env ?? process.env;
}

/**
 * Canonical AgentState bundle scaffold script — `skill/scripts/scaffold.ts`
 * (`bun scaffold.ts <instance-dir> --host=<h> --agent=<a>`).
 * `MF_AGENT_STATE_SCRIPT` overrides for a non-standard install.
 */
export function defaultScaffoldScript(seam?: ArcPackReposDirSeam): string {
  return (
    seamEnv(seam).MF_AGENT_STATE_SCRIPT ??
    arcPackScriptPath(AGENT_STATE_PACK, [...SKILL_SCRIPTS_SEGMENTS, "scaffold.ts"], seam)
  );
}

/**
 * Canonical AgentState bundle errands script — `skill/scripts/errands.ts`, a
 * SIBLING of `scaffold.ts` carrying the `pending` / `enqueue` / `claim` /
 * `resolve` / `list` / `get` / `annotate` subcommands. Kept as its own resolver
 * (rather than derived from {@link defaultScaffoldScript}) so a principal can
 * install / override the two independently via `MF_AGENT_STATE_ERRANDS_SCRIPT`.
 */
export function defaultErrandsScript(seam?: ArcPackReposDirSeam): string {
  return (
    seamEnv(seam).MF_AGENT_STATE_ERRANDS_SCRIPT ??
    arcPackScriptPath(AGENT_STATE_PACK, [...SKILL_SCRIPTS_SEGMENTS, "errands.ts"], seam)
  );
}
