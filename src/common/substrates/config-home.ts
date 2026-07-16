/**
 * Substrate config-home resolution — the "adapter translates" seam for where
 * a substrate keeps its config + auth.
 *
 * **The core concept.** Every agent-execution substrate (Claude Code, Codex,
 * Gemini, …) has a notion of a *config home*: the directory holding its
 * settings, projects, and — critically — its credential store. Relocating that
 * home is how a deployment points a substrate at, e.g., a Soma-backed profile
 * instead of the vendor default. Each substrate exposes exactly ONE env var for
 * this (Claude Code: `CLAUDE_CONFIG_DIR`; Codex: `CODEX_HOME`; …).
 *
 * **Why this module exists.** Cortex core must never hardcode a single
 * substrate's env var (`CLAUDE_CONFIG_DIR`) into an isolation allowlist or a
 * session builder — that bakes one substrate's concept into substrate-neutral
 * code. Instead, the deployment declares a substrate-neutral `configHome` path
 * per substrate (the `substrates:` config block), and this table translates it
 * to the concrete env var the substrate reads. Cortex asks the table; the table
 * owns the vendor-specific knowledge.
 *
 * **Leaf module.** Depends only on `zod`. It defines its own substrate-id tuple
 * (mirroring `AgentRuntimeSchema.substrate` in `cortex-config.ts`) rather than
 * importing the config schema, so both config schemas can import THIS without a
 * cycle.
 */

import { z } from "zod/v4";

/**
 * Config-facing substrate ids. MUST stay in sync with the `substrate` enum on
 * `AgentRuntimeSchema` (cortex-config.ts). Kept as a local tuple so this file
 * stays a leaf (no config-schema import cycle); a drift-guard test
 * (`config-home.test.ts`) asserts the two lists match so an addition to one
 * without the other fails CI rather than silently rejecting a valid substrate.
 */
export const SUBSTRATE_IDS = [
  "claude-code",
  "codex",
  "pi-dev",
  "cursor",
  "custom",
  "api-agent",
] as const;

export type SubstrateId = (typeof SUBSTRATE_IDS)[number];

/**
 * The translation table: substrate → the single env var it reads to relocate
 * its config/auth home. Absent entry = "this substrate has no config-home env
 * var cortex knows about" (e.g. `pi-dev`, a direct API call with no CLI home).
 * Fill entries in as harnesses land.
 */
export const SUBSTRATE_CONFIG_HOME_ENV: Partial<Record<SubstrateId, string>> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/**
 * Per-substrate config block. `configHome` is a substrate-NEUTRAL path — the
 * translation to a concrete env var is this module's job, not the config's.
 */
export const SubstrateConfigSchema = z
  .object({
    /**
     * Absolute path (or `~/…` / `${HOME}/…`) to the substrate's config + auth
     * home. When set, the runner exports the substrate's config-home env var
     * (see {@link SUBSTRATE_CONFIG_HOME_ENV}) on every session it spawns for
     * that substrate — so dispatched sessions resolve credentials/projects
     * against this home instead of the vendor default.
     */
    configHome: z.string().min(1).optional(),
  })
  .strict();

/**
 * Deployment/stack-level `substrates:` map — keyed by substrate id, each value
 * a {@link SubstrateConfigSchema}. All keys optional: a deployment declares only
 * the substrates whose home it wants to relocate.
 */
// `partialRecord` (not `record`): a deployment declares ONLY the substrates
// whose home it relocates — every key is optional. Plain `z.record` over an
// enum would demand all substrate ids be present and reject a block that lists
// just `claude-code`.
export const SubstratesSchema = z.partialRecord(
  z.enum(SUBSTRATE_IDS),
  SubstrateConfigSchema,
);

export type SubstratesConfig = z.infer<typeof SubstratesSchema>;

/**
 * Expand a leading `~`/`~/` and `${HOME}`/`$HOME` using `process.env.HOME`.
 * If `HOME` is unset/empty a tilde/`$HOME` path can't be resolved to an
 * absolute location, so the input is returned UNCHANGED (never silently
 * rewritten to a root-relative `/.foo`) — the caller/substrate then fails on a
 * clearly-wrong path rather than on a plausible-but-wrong one. `$HOME` only
 * matches at a word boundary so `$HOMEDIR` is left intact.
 */
function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  if (!home && (p === "~" || p.startsWith("~/") || /\$\{HOME\}|\$HOME\b/.test(p))) {
    return p;
  }
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p.replace(/\$\{HOME\}|\$HOME\b/g, home);
}

/**
 * Resolve the config-home env var to set for `substrate`, given the deployment's
 * `substrates:` config. Returns `{ name, value }` (the env var and its expanded
 * path) or `undefined` when: the deployment declared no `configHome` for this
 * substrate, OR the substrate has no known config-home env var. The caller sets
 * `env[name] = value` AFTER env-scoping so isolation stays strict default-deny —
 * this is an intentional, named export, not an inherited passthrough.
 */
export function resolveConfigHomeEnv(
  substrate: SubstrateId,
  substrates: SubstratesConfig | undefined,
): { name: string; value: string } | undefined {
  const configHome = substrates?.[substrate]?.configHome;
  if (!configHome) return undefined;
  const name = SUBSTRATE_CONFIG_HOME_ENV[substrate];
  if (!name) return undefined;
  return { name, value: expandHome(configHome) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-level active substrates — the single chokepoint.
//
// Every claude-code session cortex spawns must resolve against the SAME config
// home, but sessions are constructed at several scattered sites (chat/async
// dispatch, the autonomous dev-loop, PR review, agent-team members). Rather than
// thread `configHomeEnv` through every opts-builder — where a newly-added path
// can silently forget it and fall back to the vendor-default credential (which
// then expires independently) — the daemon sets the active `substrates:` block
// ONCE at boot (and on config reload), and the single spawn site (cc-session.ts)
// reads it. Set-once / read-at-spawn: no dispatch path can miss it.
// ─────────────────────────────────────────────────────────────────────────────
let activeSubstrates: SubstratesConfig | undefined;

/** Set the process-wide `substrates:` config. Called at daemon boot + reload. */
export function setActiveSubstrates(substrates: SubstratesConfig | undefined): void {
  activeSubstrates = substrates;
}

/**
 * Resolve the config-home env var for `substrate` from the process-wide
 * `substrates:` config set by {@link setActiveSubstrates}. Returns `undefined`
 * when nothing was set, the substrate declared no `configHome`, or the substrate
 * has no known config-home env var — the caller then leaves the child on its
 * default home. This is the read side of the single chokepoint (cc-session).
 */
export function activeConfigHomeEnv(
  substrate: SubstrateId,
): { name: string; value: string } | undefined {
  return resolveConfigHomeEnv(substrate, activeSubstrates);
}

/**
 * Build the env for spawning `substrate`'s binary — or a subprocess that will
 * itself exec it — by layering the configured config home on top of `baseEnv`
 * (default: this process's env). Returns `undefined` when no config home is
 * declared, so the caller can OMIT `env` entirely and let the child inherit
 * (the pre-existing behaviour) rather than needlessly rebuilding it.
 *
 * `undefined` values in `baseEnv` are dropped, not stringified — matching what
 * a plain inherit does.
 *
 * EXPORTED, and deliberately NOT inlined at the spawn sites: those wrappers are
 * injection-seam defaults that every test replaces with a fake, so logic left
 * inside them is never executed by the suite and can be silently reverted with
 * CI green. Keeping the decision here makes it directly unit-testable.
 *
 * KNOWN GAP: this only reaches spawns cortex performs itself. A deployment-
 * authored process spec run via `bus/process-runner.ts` gets an env pass-through
 * ALLOWLIST (it forwards vars cortex already has; it cannot ADD one), so a
 * `claude` invoked that way has no route to the declared home.
 */
export function configHomeSpawnEnv(
  substrate: SubstrateId,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  const configHome = activeConfigHomeEnv(substrate);
  if (!configHome) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) out[key] = value;
  }
  out[configHome.name] = configHome.value;
  return out;
}
