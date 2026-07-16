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
 * Config-facing substrate ids. Mirrors the `substrate` enum on
 * `AgentRuntimeSchema` (cortex-config.ts). Kept as a local tuple so this file
 * stays a leaf (no config-schema import cycle); keep the two lists in sync when
 * a new substrate lands.
 */
export const SUBSTRATE_IDS = [
  "claude-code",
  "codex",
  "pi-dev",
  "cursor",
  "custom",
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

/** Expand a leading `~`/`~/` and `$HOME`/`${HOME}` using `process.env.HOME`. */
function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p.replace(/\$\{HOME\}|\$HOME/g, home);
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
