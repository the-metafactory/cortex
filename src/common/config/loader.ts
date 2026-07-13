/**
 * G-500: Config Loader
 *
 * Loads central bot.yaml + per-network files from networks/ directory.
 * Apache/nginx-style: shared settings in bot.yaml, per-network files for
 * platform instances, cloud endpoints, repos, and security overrides.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname, resolve, isAbsolute, basename } from "path";
import { parse as parseYaml } from "yaml";
import { AgentConfigSchema, NetworkFileSchema, type AgentConfig, type NetworkFile } from "../types/config";
import {
  AgentSchema,
  CortexConfigSchema,
  type Agent,
  type BusConfig,
  type CortexConfig,
  type DiscordPresence,
  type MattermostPresence,
  type NotifyConfig,
  type Policy,
  type ReflexActivationConfig,
  type SlackPresence,
  type StackConfig,
} from "../types/cortex-config";
import { z } from "zod/v4";
import {
  foldSurfaceBindings,
  SurfacesSchema,
  DEFAULT_FOLD_PLATFORMS,
  EXTRACTED_ADAPTER_PLATFORMS,
  type Surfaces,
} from "../types/surfaces";
import {
  createDefaultSurfacePluginRegistry,
  validateSurfacesAgainstRegistry,
  type SurfacePluginRegistry,
} from "../../adapters/registry";
import { resolveRendererPluginAndConfig } from "../../renderers";
import { enforceChmod600 } from "./file-permissions";
import {
  resolveAgentPresenceTokens,
  resolveSurfaceBindingTokens,
  resolveSurfaceTokensInRawConfig,
  type SurfaceTokenWarning,
} from "./resolve-env-placeholders";

export type { SurfaceTokenWarning } from "./resolve-env-placeholders";

/**
 * Hardening cap on a single fragment file's size. Echo M3 on cortex#62 —
 * unbounded readFileSync against an attacker- or accident-controlled file
 * in agents.d/ is a footgun. 1MB is ~4 orders of magnitude over a realistic
 * fragment (~1KB); the guard catches mistakes (principal drops the wrong
 * file) and worst-case-malicious drops alike before they consume memory or
 * stall the loader.
 */
const FRAGMENT_MAX_BYTES = 1_048_576; // 1 MiB

/**
 * Expand a leading `~` in a path to `$HOME`. Single source of truth for the
 * loader + watcher to avoid drift (Echo M1 on cortex#62).
 *
 * Throws when `$HOME` is unset and the path needs expansion (Echo N3 — was
 * silently returning literal `~` strings). A path that doesn't start with
 * `~` is returned verbatim regardless of `$HOME`.
 */
export function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      throw new Error(`cannot expand "~" in path "${p}": $HOME is not set`);
    }
    return p === "~" ? home : join(home, p.slice(2));
  }
  // Bare `~foo` (no slash) is not expanded — that's user-name resolution
  // semantics we explicitly don't support here. Return verbatim.
  return p;
}

/**
 * Result of `loadConfigWithAgents`. `inlineAgents` is non-empty when the
 * loader detected cortex-shape config (architecture §9.1 — `principal:` +
 * `agents:[]` instead of legacy `agent:` + flat `discord:[]`). The `config`
 * field is always an AgentConfig — for cortex-shape input it's a synthesized
 * legacy-compatible projection so downstream consumers stay unchanged
 * during MIG-7. Callers that need the rich cortex shape use `inlineAgents`.
 *
 * `stack` (IAW Phase A.5, cortex#113): the optional top-level `stack:` block
 * from cortex-shape input, surfaced raw so the boot path can call
 * `deriveStackId` without re-parsing the file. Undefined for legacy bot.yaml
 * input (the block lives on `CortexConfigSchema` only — `AgentConfigSchema` has
 * no equivalent during the MIG-7.2 overlap window). When the principal
 * declares `stack: { id: andreas/research }`, this field carries the
 * validated object; when the block is omitted, the field stays undefined and
 * `deriveStackId` default-derives `${principal.id}/default`.
 */
export interface LoadedConfig {
  config: AgentConfig;
  inlineAgents: Agent[];
  /**
   * v2.0.0 (cortex#297) — principal's platform-side ids surfaced through the
   * loader after `agent.operatorDiscordId/Mattermost/Slack` retired from
   * AgentConfig. Populated only for cortex-shape configs (legacy bot.yaml
   * input always yields `undefined`). The boot path reads these to wire
   * `DiscordAdapterInfra.principal.discordId` etc.
   */
  principal?: {
    id: string;
    /**
     * cortex#429 PR-C — surface the principal's display name onto the
     * loaded boot-time view so dashboard wiring no longer has to dip
     * back into the removed `AgentConfig.agent.operatorName` legacy
     * field. Optional — principals can omit `principal.displayName` on
     * cortex.yaml and the boot path falls back to `principal.id`.
     */
    displayName?: string;
    discordId?: string;
    mattermostId?: string;
    slackId?: string;
  };
  /**
   * Optional stack identity (IAW A.5.3, cortex#113). Populated only when the
   * input was cortex-shape AND the principal declared a `stack:` block.
   * Legacy bot.yaml input always yields `undefined`. See `deriveStackId` in
   * `src/common/types/stack.ts` for the boot-time resolver that consumes this.
   */
  stack?: StackConfig;
  /**
   * Optional policy block (IAW C.3.1, cortex#115). Populated only when
   * the input was cortex-shape AND the principal declared a `policy:`
   * block. Legacy bot.yaml input always yields `undefined`. The boot
   * path passes this through to `policyEngineFromConfig` which returns
   * `undefined` when the block is absent OR has no principals — in
   * which case the dispatch-listener falls back to the legacy
   * unauthenticated path until C.2b removes it.
   */
  policy?: Policy;
  /**
   * Optional bus provisioning block from cortex-shape input. Defaults are
   * already applied by CortexConfigSchema. Legacy bot.yaml input yields
   * undefined and the boot path uses hardcoded defaults.
   */
  bus?: BusConfig;
  /**
   * Optional surface binding map (IAW GW, cortex#524). Populated only when
   * the input declared a `surfaces:` block / surfaces.yaml layer. Consumed
   * by the runtime gateway bootstrap (`maybeCreateSurfaceGateway`). Legacy
   * bot.yaml input yields undefined.
   */
  surfaces?: Surfaces;
  /**
   * F-6 — reflex activation bridge block. Always defined for cortex-shape
   * input (CortexConfigSchema applies an empty-default); `undefined` for
   * legacy bot.yaml input. The boot path mounts `ReflexActivationListener`
   * only when `targets` is non-empty.
   */
  reflexActivation?: ReflexActivationConfig;
  /**
   * F-6 downstream — `notify:` block (outbound code-capability routing, e.g.
   * notify.discord). Always defined for cortex-shape input (empty-default);
   * `undefined` for legacy bot.yaml input.
   */
  notify?: NotifyConfig;
  /**
   * cortex#1217 — surfaces disabled by fail-soft surface-token degradation. A
   * surface secret placeholder (`presence.discord.token: __VEGA_BOT_TOKEN__`,
   * the surfaces.yaml gateway bindings, …) whose env var is unset/empty no
   * longer aborts the whole config load (which crash-looped the daemon and took
   * the WHOLE stack offline) — that ONE surface is disabled + scrubbed, and the
   * load continues. Each disabled surface is recorded here so the boot path can
   * re-surface a consolidated principal-facing notification (the resolver
   * already emits a per-surface stderr WARN at load time). Absent / empty when
   * every surface token resolved.
   */
  surfaceWarnings?: SurfaceTokenWarning[];
}

/**
 * Detect whether `raw` is a cortex-shape config (principal/operator + agents[])
 * vs the legacy grove-v2 `bot.yaml` shape (singular agent + flat discord[]).
 *
 * The check is structural — must have a principal block (`principal:` or the
 * legacy `operator:`, object) AND `agents:` (non-empty array). Either field on
 * its own keeps the legacy path so a partially-migrated config surfaces the
 * relevant zod errors via AgentConfigSchema (legacy) rather than
 * CortexConfigSchema's anti-field rejections.
 */
interface ZodLikeIssue {
  path?: (string | number)[];
  message: string;
}
interface ZodLikeError {
  issues?: ZodLikeIssue[];
  errors?: ZodLikeIssue[];
}

/**
 * Runtime check for a Zod-shaped error. Zod v3 exposes `.errors`, Zod v4
 * exposes `.issues`. Cortex's schemas straddle both — accept either.
 */
function isZodLikeError(err: unknown): err is ZodLikeError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { issues?: unknown; errors?: unknown };
  return Array.isArray(e.issues) || Array.isArray(e.errors);
}

/**
 * R3 vocabulary migration (cortex#388) — v4.0.0 BREAKING CUT. Resolve the
 * principal block from a cortex-shape config. cortex.yaml requires the
 * canonical `principal:` key; the legacy top-level `operator:` block reader
 * is GONE. A config still carrying an `operator:` block is no longer
 * recognised as cortex-shape — it falls through to the bot.yaml-shape
 * detection path and the principal is steered toward `cortex migrate-config`,
 * which continues to read legacy `operator:`-shaped input.
 *
 * The transition-era dual-block guard (`DualBlockConflictError`, raised when
 * a config carried BOTH `principal:` and a legacy `operator:` block) retired
 * with this cut: there is no longer an `operator:` reader to be ambiguous
 * against.
 */
function resolvePrincipalBlock(
  raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (raw.principal !== null && typeof raw.principal === "object") {
    return raw.principal as Record<string, unknown>;
  }
  return undefined;
}

function isCortexShape(raw: Record<string, unknown>): boolean {
  // v4.0.0 BREAKING — cortex.yaml requires the canonical `principal:` key.
  return (
    resolvePrincipalBlock(raw) !== undefined &&
    Array.isArray(raw.agents) &&
    raw.agents.length > 0
  );
}

/**
 * Load bot.yaml + networks/*.yaml, validate, merge.
 *
 * Backwards-compatible wrapper that returns just the AgentConfig — callers
 * that need cortex-shape `inlineAgents` should use `loadConfigWithAgents`.
 */
export function loadConfig(path: string): AgentConfig {
  return loadConfigWithAgents(path).config;
}

// =============================================================================
// IAW CFG.a — multi-file config composer + transitional single-file fallback
// =============================================================================
//
// CFG.a is a config-INGESTION refactor only: it builds the SAME `raw` object
// `parseYaml(cortex.yaml)` produces, then feeds it through the existing
// parse/build so `LoadedConfig` stays byte-identical. No consumer edits.
//
// Two ingestion paths, resolved deterministically by `composeRawConfig`:
//
//   1. Directory layout (CFG.a.1) — the config dir contains a marker file
//      `system/system.yaml`. The composer reads the layer files in a fixed
//      precedence order and deep-merges them into one raw object:
//
//          system/system.yaml   (base — cross-cutting machine config)
//          network/*.yaml        (sorted by filename)
//          surfaces/surfaces.yaml
//          stacks/*.yaml         (sorted by filename)
//
//      Later layers win on leaf keys (deep-merge of objects; arrays + scalars
//      replace wholesale — see `deepMerge`). The order is system → network →
//      surfaces → stacks because system is the most general (machine-wide)
//      and stacks are the most specific (per-deployment) — specific overrides
//      general, the conventional config-cascade direction (Apache/nginx-style,
//      matching the G-500 networks/ precedent).
//
//   2. Single-file fallback (CFG.a.2) — no `system/system.yaml` marker present.
//      Read the single `cortex.yaml` (or bot.yaml) at `configPath` exactly as
//      before. Identical `LoadedConfig`, no principal-facing break.
//
// Resolution rule (CFG.a.3): directory layout present (marker file exists) →
// use it; else single-file fallback. The composer is deterministic (fixed
// layer order, filename-sorted globs) and idempotent (composing twice yields
// the same object — `deepMerge` is a pure fold, no in-place mutation of inputs).

/** The marker file whose presence selects the directory-layout path. */
const LAYOUT_MARKER = join("system", "system.yaml");

/**
 * Deep-merge `source` onto `base`, returning a new object. Plain objects are
 * merged recursively; arrays and scalars from `source` replace the `base`
 * value wholesale (no element-wise array merge — config arrays like
 * `agents[]` / `nats.subjects[]` are replace-or-keep units, not append lists;
 * element-wise merge would silently splice fragments together in surprising
 * orders). Neither input is mutated — both are treated as read-only, so
 * composing the same layers twice yields an identical result (idempotent).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(
  base: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const bv = out[key];
    if (isPlainObject(bv) && isPlainObject(sv)) {
      out[key] = deepMerge(bv, sv);
    } else {
      // Arrays + scalars (and object-over-non-object / non-object-over-object)
      // replace wholesale. structuredClone keeps the merged object detached
      // from the source layer so later idempotent re-composition can't alias
      // and mutate a shared nested array/object.
      out[key] = structuredClone(sv);
    }
  }
  return out;
}

/**
 * List `*.yaml` / `*.yml` files in `dir` in deterministic (sorted) order,
 * skipping dotfiles. Returns `[]` when `dir` is absent. Single source of truth
 * for the yaml-listing pattern the composer (`listLayerFiles`), the network
 * loader (`loadNetworkFiles`), and the agents loader (`loadAgentsDirectory`)
 * all need — extracted so they cannot drift (Echo nit #3 on cortex#525; the
 * pre-extraction `listLayerFiles` block had already drifted from
 * `loadNetworkFiles`, which did not skip dotfiles).
 */
function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
}

/**
 * Read + parse a single YAML layer file into a raw record. Returns `{}` for a
 * file that parses to null/empty (an empty layer contributes nothing to the
 * merge). Throws a clear error on YAML parse failure so a malformed layer
 * fails loudly at load rather than silently dropping config.
 *
 * Echo nit #1 on cortex#525 — a per-layer byte cap (parity with the
 * `FRAGMENT_MAX_BYTES` guard on `loadAgentFromFile`). An unbounded
 * `readFileSync` against an accident- or attacker-controlled layer file in
 * `system/` / `stacks/` is the same footgun the fragment loader already guards;
 * the cap stops a runaway file from consuming memory or stalling the loader.
 */
function readLayerFile(filePath: string): Record<string, unknown> {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    throw new Error(
      `config-composer: failed to stat layer ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (size > FRAGMENT_MAX_BYTES) {
    throw new Error(
      `config-composer: layer ${filePath} exceeds ${FRAGMENT_MAX_BYTES} bytes (got ${size}); refusing to read`,
    );
  }

  const content = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    throw new Error(
      `config-composer: failed to parse layer ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) {
    throw new Error(
      `config-composer: layer ${filePath} must be a YAML mapping at the top level, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parsed;
}

/**
 * List `*.yaml` / `*.yml` layer files in `dir` as full paths, in deterministic
 * (sorted) order. Returns `[]` when `dir` is absent — an optional layer
 * directory contributes nothing. Thin wrapper over the shared `listYamlFiles`
 * helper that joins each entry to `dir` (the composer wants paths; the agents +
 * networks loaders want filenames to re-join against an expanded base dir).
 */
function listLayerFiles(dir: string): string[] {
  return listYamlFiles(dir).map((f) => join(dir, f));
}

/**
 * GW.a.3b.2a surfaces-aware variant of the composer (cortex#524).
 *
 * Seam choice: option (b) — this new `composeRawConfigWithSurfaces` function
 * captures the validated `Surfaces` object BEFORE `foldSurfaceBindings` drops
 * the top-level `surfaces:` key, and returns it alongside the folded `raw`.
 * `composeRawConfig` delegates here and returns only `.raw`, so its existing
 * signature and every caller (composer tests, external consumers) are
 * untouched. `loadConfigWithAgents` calls this variant directly and threads
 * `.surfaces` through to `LoadedConfig.surfaces`.
 *
 * Caller blast-radius: zero — `composeRawConfig`'s signature is unchanged.
 *
 * HARD INVARIANT: the `.raw` returned is byte-identical to what
 * `composeRawConfig` returned pre-GW.a.3b.2a. The fold is unchanged; the only
 * addition is the separately captured `surfaces` value.
 */
// Not exported — `loadConfigWithAgents` is the public entry for the `surfaces`
// field; `composeRawConfig` (the delegating wrapper below) stays the public
// raw-compose API for its existing callers.
function composeRawConfigWithSurfaces(configPath: string): {
  raw: Record<string, unknown>;
  surfaces: Surfaces | undefined;
} {
  const expandedPath = expandTilde(configPath);
  const configDir = dirname(expandedPath);
  const markerPath = join(configDir, LAYOUT_MARKER);

  // CFG.a.3 resolution rule: directory layout present → use it; else fallback.
  if (!existsSync(markerPath)) {
    // CFG.a.2 — single-file fallback. Capture any `surfaces:` block BEFORE
    // the fold so `LoadedConfig.surfaces` is populated symmetrically with the
    // directory-layout path (CFG.c design: both ingestion paths are symmetric).
    //
    // TC-4a (cortex#636) — the single `cortex.yaml` carries platform BOT
    // TOKENS (Discord/Slack/Mattermost) inline, so it gets the same
    // chmod-600 gate the nkey-seed (`stack-signing-key.ts`) and NATS
    // `.creds` (`bus/nats/connection.ts`) loaders already enforce via the
    // shared `enforceChmod600` helper. Sync `statSync` keeps the
    // stat-then-read TOCTOU window as tight as the sibling loaders'; the
    // daemon owns its config dir, so the practical risk is near zero — an
    // attacker who can swap files there has already won. The helper skips
    // the gate on win32 (NTFS ACLs are the principal's responsibility).
    enforceChmod600(expandedPath);
    const content = readFileSync(expandedPath, "utf-8");
    const single = (parseYaml(content) ?? {}) as Record<string, unknown>;
    const surfaces = parseSurfaces(single.surfaces);
    return { raw: foldSurfaceBindings(single, defaultFoldPlatforms()), surfaces };
  }

  // CFG.a.1 — directory layout. Fixed precedence: system → network → surfaces
  // → stacks (later wins on leaf keys).
  const layerFiles: string[] = [
    markerPath,
    ...listLayerFiles(join(configDir, "network")),
    ...(existsSync(join(configDir, "surfaces", "surfaces.yaml"))
      ? [join(configDir, "surfaces", "surfaces.yaml")]
      : []),
    ...listLayerFiles(join(configDir, "stacks")),
  ];

  let merged: Record<string, unknown> = {};
  for (const file of layerFiles) {
    merged = deepMerge(merged, readLayerFile(file));
  }
  // Capture surfaces BEFORE the fold drops the `surfaces:` key. The fold
  // itself (`foldSurfaceBindings`) already calls `SurfacesSchema.parse`
  // internally — `parseSurfaces` re-uses the same schema so the parse is
  // redundant but cheap (no I/O). Both share the same validated result shape.
  const surfaces = parseSurfaces(merged.surfaces);
  return { raw: foldSurfaceBindings(merged, defaultFoldPlatforms()), surfaces };
}

/**
 * cortex#1789 (S4, ADR-0024 D5 scope item 3) — the registry-derived
 * fold-platform list: every registered `AdapterPlugin` that opts into
 * `foldsIntoPresence`. Replaces the hardcoded `PLATFORMS` const that used to
 * live in `surfaces.ts` — "which platforms fold" is now a property each
 * plugin declares (discord `true`, web `false` — PRESERVED exactly; slack
 * and mattermost are ALSO `true` but are no longer resolvable from the
 * in-tree default alone post-extraction — see {@link DEFAULT_FOLD_PLATFORMS},
 * the registry-free anchor this unions with below) rather than a second list
 * that could drift from the registry. `surfaces.ts` itself cannot import the
 * registry (would cycle — the registry's in-tree adapter plugins import
 * `surfaces.ts` for their binding schemas), so `loader.ts` — which already
 * imports the registry for the registry-pass validation below — computes
 * this list.
 */
function defaultFoldPlatforms(): readonly string[] {
  const fromRegistry = createDefaultSurfacePluginRegistry()
    .listAdapters()
    .filter((p) => p.foldsIntoPresence)
    .map((p) => p.platform);
  // cortex#1795/#1796 (S10/S11 MOVE) — `slack`/`mattermost` extracted
  // out-of-tree: neither appears in the SYNCHRONOUS in-tree registry this
  // function builds (config load happens before `loadExternalPlugins`' async
  // bundle discovery runs, so an out-of-tree plugin's `foldsIntoPresence:
  // true` flag is invisible here even though it's unchanged). Union with
  // {@link DEFAULT_FOLD_PLATFORMS} — the registry-free anchor — so both
  // platforms' legacy `agents[*].presence.{slack,mattermost}` fold behavior
  // survives extraction; extraction moved the plugin CODE, not this fold
  // contract.
  return [...new Set([...fromRegistry, ...DEFAULT_FOLD_PLATFORMS])];
}

/**
 * cortex#1796 (S11 MOVE), cortex#1797 (S12 MOVE) — the registry used by
 * {@link parseSurfaces}'s REGISTRY pass. Starts from the SYNCHRONOUS in-tree
 * registry (`createDefaultSurfacePluginRegistry()` — config load happens
 * BEFORE `loadExternalPlugins`' async bundle discovery runs) and supplements
 * it with a permissive STUB `AdapterPlugin` for every platform in
 * {@link EXTRACTED_ADAPTER_PLATFORMS} not already registered (`web`,
 * `mattermost`, `slack`, and — as of S12 — `discord` too, now that it
 * extracted out-of-tree and `createDefaultSurfacePluginRegistry()` composes
 * ZERO in-tree adapters) — otherwise a stack with a legitimately-declared
 * `surfaces.{platform}[]` binding would fail to LOAD at all, since that
 * platform's real plugin isn't visible to this synchronous registry
 * (cortex#1796 review finding — mattermost/slack, unlike `web`, have a live
 * production `foldsIntoPresence: true` fold path, so this one actually broke
 * real config loads, not just a theoretical gap; discord inherits the same
 * risk at S12 since it folds too).
 *
 * The stub's `bindingSchema` is fully permissive (`z.record(...)`) — it
 * only proves "this platform key is a KNOWN, first-party-exempt adapter,
 * not a typo", deferring the REAL per-field validation to boot time, once
 * `loadExternalPlugins` has actually loaded the bundle and
 * `cortex.ts` re-runs `validateSurfacesAgainstRegistry` against the
 * fully-loaded registry. A genuinely unknown/misspelled platform key (not
 * in {@link EXTRACTED_ADAPTER_PLATFORMS}) still fails loudly here, unchanged
 * — every platform cortex ships is in that set now, so this loop is the
 * SOLE source of load-time adapter admission.
 */
function surfacesParseRegistry(): SurfacePluginRegistry {
  const registry = createDefaultSurfacePluginRegistry();
  for (const platform of EXTRACTED_ADAPTER_PLATFORMS) {
    if (registry.getAdapter(platform)) continue;
    registry.registerAdapter({
      kind: "adapter",
      id: platform,
      platform,
      bindingSchema: z.record(z.string(), z.unknown()),
      foldsIntoPresence: false,
      secretFields: [],
      demuxKey: () => platform,
      buildGatewayConstructArgs: (_group, base) => ({ instanceId: base.instanceId }),
      createAdapter: () => {
        throw new Error(
          `surfacesParseRegistry: "${platform}" is a config-load-time structural stub — ` +
            "it must never be constructed. Real construction routes through the bundle-loaded " +
            "plugin registered by loadExternalPlugins at boot.",
        );
      },
    });
  }
  return registry;
}

/**
 * Parse the raw `surfaces:` value against `SurfacesSchema` (the STRUCTURAL
 * pass), then run the REGISTRY pass (cortex#1789, S4) — every top-level key
 * must name an installed adapter plugin, and every entry's `binding` must
 * satisfy that plugin's `bindingSchema`. Returns `undefined` when the value
 * is absent or null (no surfaces declared). Throws on malformed input or an
 * unregistered platform — the caller (`composeRawConfigWithSurfaces`) lets
 * this propagate so a bad surfaces.yaml (or a typo'd platform key) fails
 * loudly at load, matching `foldSurfaceBindings`'s own validation contract
 * and giving `cortex config validate`/dry-run/`migrate-config` callers (who
 * never reach `cortex.ts`'s boot-time registry check) the same loud typo
 * guard `.strict()` used to give directly.
 */
function parseSurfaces(value: unknown): Surfaces | undefined {
  if (value === undefined || value === null) return undefined;
  const surfaces = SurfacesSchema.parse(value);
  validateSurfacesAgainstRegistry(surfaces, surfacesParseRegistry());
  return surfaces;
}

/**
 * CFG.a.1 — compose the raw config object from a directory layout, or fall
 * back to the single file (CFG.a.2).
 *
 * `configPath` is the path the caller already passes (e.g. a `cortex.yaml`
 * file). Layout detection keys off the file's directory: if
 * `${dir}/system/system.yaml` exists, the directory layout is used; otherwise
 * the single file at `configPath` is read verbatim.
 *
 * Returns the merged `raw` object — the exact shape `parseYaml(cortex.yaml)`
 * yields — so the existing `loadConfigWithAgents` parse/build is unchanged.
 *
 * Delegates to `composeRawConfigWithSurfaces` and returns only `.raw`.
 * Callers that need `LoadedConfig.surfaces` should use `loadConfigWithAgents`.
 */
export function composeRawConfig(configPath: string): Record<string, unknown> {
  return composeRawConfigWithSurfaces(configPath).raw;
}

/**
 * MIG-7.2e — config-schema flip.
 *
 * Loads either:
 *   - legacy grove-v2 `bot.yaml` (agent: + flat discord:[] + mattermost:[]),
 *   - or cortex-shape `cortex.yaml` (principal: + agents:[] with per-agent
 *     presence: blocks),
 *
 * and returns a `LoadedConfig` with:
 *   - `config`: an AgentConfig (legacy shape, possibly synthesized from cortex
 *      shape for downstream-consumer parity),
 *   - `inlineAgents`: the cortex-shape `agents[]` when present; empty for
 *      legacy input.
 *
 * Detection is structural: presence of `principal:` (object) + `agents:`
 * (non-empty array) → cortex; anything else → legacy. The two anti-field
 * rejections in `CortexConfigSchema` (legacy `agent:` / `discord:` /
 * `mattermost:` / `trustedAgentBots:` at the top level) surface as zod
 * errors only when the detection trips the cortex branch.
 *
 * IAW CFG.a — the raw config object is now built by `composeRawConfig`, which
 * either deep-merges a directory layout (`system/`, `network/`, `surfaces/`,
 * `stacks/`) or reads the single `cortex.yaml` verbatim. `LoadedConfig` is
 * unchanged across both paths.
 */
export function loadConfigWithAgents(path: string): LoadedConfig {
  // Echo nit #2 on cortex#525 — expand the tilde ONCE here via the fail-loud
  // helper, then hand the already-expanded path to `composeRawConfigWithSurfaces`
  // (`expandTilde` is idempotent on an absolute path), removing the redundant
  // double expansion that previously happened in both functions.
  const expandedPath = expandTilde(path);
  const configDir = dirname(expandedPath);

  // CFG.a.1/CFG.a.2 — compose from directory layout or fall back to single
  // file. Capture the validated `Surfaces` binding map before the fold drops
  // the top-level `surfaces:` key (GW.a.3b.2a, cortex#524).
  const { raw, surfaces } = composeRawConfigWithSurfaces(expandedPath);

  // cortex#1209 / cortex#1217 — resolve `__ENV__` placeholders in the surface
  // secret fields (`agents[].presence.{discord.token, mattermost.apiToken,
  // slack.botToken/appToken}`) from `process.env` BEFORE the schema parse. Runs
  // here, after the deep-merge compose, so the resolved value reaches the
  // flattened presence → adapter login, and so the Slack `^xoxb-`/`^xapp-`
  // regexes in SlackPresenceSchema see a real token rather than a placeholder.
  //
  // cortex#1217: a declared placeholder with an UNSET env var no longer throws
  // (which FATAL-booted the daemon → launchd crash loop → whole stack offline).
  // Instead that ONE surface is disabled (`presence.<platform>.enabled = false`)
  // + the literal scrubbed, the load continues, and the miss is recorded in
  // `surfaceWarnings` (the resolver also emits a per-surface stderr WARN). A
  // resolved placeholder still resolves; an inline token is byte-identical.
  // Mutates `raw` in place (it is a freshly composed object — see
  // `deepMerge`/single-file `parseYaml`).
  const surfaceWarnings: SurfaceTokenWarning[] = [];
  resolveSurfaceTokensInRawConfig(raw, surfaceWarnings);

  // cortex#1209 review (MAJOR) — the captured `surfaces` binding map is a
  // SEPARATE pre-fold object threaded straight to the surface gateway
  // (`buildGatewayAdapters`), bypassing the `raw.agents[]` walk above. Resolve
  // its `binding.<token>` fields too so the `CORTEX_GATEWAY=1` path can never
  // hand a literal `__X__` to Discord/Mattermost `connect()`. cortex#1217: an
  // unresolvable binding ENTRY is dropped (the gateway has no per-binding
  // enabled flag), recorded in the same `surfaceWarnings` sink. Mutates the
  // freshly-parsed `surfaces` object in place.
  if (surfaces !== undefined) resolveSurfaceBindingTokens(surfaces, surfaceWarnings);

  // Networks load against the on-disk path regardless of legacy/cortex shape —
  // both shapes share the same networks/ contract (G-500).
  //
  // cortex#88 item 7: `explicitNetworksDir` was true whenever `networksDir`
  // appeared anywhere in raw yaml — but migrate-config emits the schema
  // default (`./networks`) verbatim, so every startup tripped the
  // `does not exist` warn. Treat the literal default value as "not
  // explicit" so the warning fires only when the principal pointed
  // networksDir at a non-default path that's actually missing.
  const explicitNetworksDir =
    typeof raw.networksDir === "string" && raw.networksDir !== "./networks";
  const networksDir = resolve(
    configDir,
    (typeof raw.networksDir === "string" ? raw.networksDir : "./networks"),
  );
  const networks = loadNetworkFiles(networksDir, explicitNetworksDir);

  // cortex#1217 — a surfaces.yaml binding is BOTH folded into the per-agent
  // `presence` (so `resolveSurfaceTokensInRawConfig` disables it) AND resolved
  // on the separately-captured gateway `surfaces` object (so
  // `resolveSurfaceBindingTokens` drops it) — one missing env var therefore
  // produces two records for the same root cause. Dedupe by agent+platform+var
  // so the boot path bubbles each disabled surface up ONCE.
  const dedupedWarnings = dedupeSurfaceWarnings(surfaceWarnings);

  if (isCortexShape(raw)) {
    const loaded = loadCortexShape(raw, networks, surfaces);
    // Thread any fail-soft disabled-surface warnings through so the boot path
    // can re-surface them. Only attach when non-empty (keeps the happy-path
    // `LoadedConfig` byte-identical to pre-#1217).
    return dedupedWarnings.length > 0 ? { ...loaded, surfaceWarnings: dedupedWarnings } : loaded;
  }

  // ---------------------------------------------------------------------
  // Legacy bot.yaml path — unchanged from pre-MIG-7.2e behaviour.
  // ---------------------------------------------------------------------

  // Legacy fallback: if no network files and legacy api.* fields exist, create default network
  let isLegacyMode = false;
  if (networks.length === 0 && !raw.networksDir && hasLegacyCloudConfig(raw)) {
    networks.push(buildLegacyNetwork(raw));
    isLegacyMode = true;
  }

  // Aggregate discord/mattermost from networks into top-level arrays.
  // Top-level `raw.discord` / `raw.mattermost` may be either a single
  // object or an array — normalize to array, ignore everything else.
  const rawDiscord = raw.discord;
  const rawMattermost = raw.mattermost;
  const topDiscord: unknown[] = Array.isArray(rawDiscord)
    ? rawDiscord
    : rawDiscord !== undefined && rawDiscord !== null
      ? [rawDiscord]
      : [];
  const topMattermost: unknown[] = Array.isArray(rawMattermost)
    ? rawMattermost
    : rawMattermost !== undefined && rawMattermost !== null
      ? [rawMattermost]
      : [];
  const aggregatedDiscord = isLegacyMode
    ? networks.flatMap((n) => n.discord)
    : [...topDiscord, ...networks.flatMap((n) => n.discord)];
  const aggregatedMattermost = isLegacyMode
    ? networks.flatMap((n) => n.mattermost)
    : [...topMattermost, ...networks.flatMap((n) => n.mattermost)];

  const merged = {
    ...raw,
    discord: aggregatedDiscord,
    mattermost: aggregatedMattermost,
    networks,
    networksDir: raw.networksDir ?? "./networks",
  };

  return {
    config: AgentConfigSchema.parse(merged),
    inlineAgents: [],
    // cortex#1217 — legacy bot.yaml carries inline tokens (no agents[].presence
    // walk), so this is normally empty; attach for shape-parity when non-empty.
    ...(dedupedWarnings.length > 0 && { surfaceWarnings: dedupedWarnings }),
  };
}

/**
 * cortex#1217 — collapse duplicate disabled-surface warnings (a surfaces.yaml
 * binding is reported by both the folded-presence walk and the gateway-binding
 * resolver) to one record per `agent|platform|envVar`, preserving first-seen
 * order. The per-surface stderr WARN still fires at resolve time; this is the
 * structured "bubble up once" list the boot path consumes.
 */
export function dedupeSurfaceWarnings(warnings: SurfaceTokenWarning[]): SurfaceTokenWarning[] {
  const seen = new Set<string>();
  const out: SurfaceTokenWarning[] = [];
  for (const w of warnings) {
    const key = `${w.agent}|${w.platform}|${w.envVar}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Convert a cortex-shape `cortex.yaml` into a `LoadedConfig`.
 *
 * Strategy (MIG-7.2e):
 *   1. Parse via `CortexConfigSchema` — strict, rejects legacy top-level
 *      `agent:` / `discord:[]` / `mattermost:[]` / `trustedAgentBots:`
 *      blocks with principal-friendly migration errors.
 *   2. Flatten `agents[*].presence.{discord,mattermost}` into the legacy
 *      `AgentConfig.{discord,mattermost}[]` arrays — each entry inherits
 *      the parent agent's id as a synthesized `instanceId` matching the
 *      MIG-7.2c convention (`${agent.id}-{platform}`).
 *   3. Synthesize a singular `agent:` block from the principal block plus
 *      the first agent — this keeps the legacy AgentConfig contract intact
 *      while the multi-agent identity routing flows via `inlineAgents`
 *      through `startCortex`.
 *   4. Pass renderers/claude/attachments/execution/github/paths/nats
 *      through verbatim — they're identical in both schemas.
 *   5. Drop `trustedAgentBots:` (cortex expresses peer trust via per-agent
 *      `trust:` lists; legacy aggregation would lose the per-agent shape).
 */
/**
 * v2.0.0 cutover (cortex#297) — reject legacy `presence.<platform>.roles[]`,
 * `presence.discord.dm`, and `agents[].roles[]` fields with a principal-
 * actionable error pointing at `migrate-config`. Zod's default-strip
 * behaviour would silently drop these fields post-cutover; legacy principals
 * upgrading without running `migrate-config` first would see their auth
 * configuration vanish without warning. Detection happens BEFORE Zod parse
 * so the error message carries the exact field path principals see in their
 * own cortex.yaml.
 */
function detectLegacyAuthorisationFields(raw: Record<string, unknown>): string[] {
  const offenders: string[] = [];
  const agents = raw.agents;
  if (!Array.isArray(agents)) return offenders;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i] as Record<string, unknown> | undefined;
    if (!agent || typeof agent !== "object") continue;
    if (Array.isArray(agent.roles) && agent.roles.length > 0) {
      offenders.push(`agents[${i}].roles[]`);
    }
    const presence = agent.presence as Record<string, unknown> | undefined;
    if (!presence || typeof presence !== "object") continue;
    for (const platform of ["discord", "mattermost", "slack"] as const) {
      const block = presence[platform] as Record<string, unknown> | undefined;
      if (!block || typeof block !== "object") continue;
      if (Array.isArray(block.roles) && block.roles.length > 0) {
        offenders.push(`agents[${i}].presence.${platform}.roles[]`);
      }
      if (block.defaultRole !== undefined) {
        offenders.push(`agents[${i}].presence.${platform}.defaultRole`);
      }
      if (platform === "discord" && block.dm !== undefined) {
        offenders.push(`agents[${i}].presence.discord.dm`);
      }
    }
  }
  // Top-level policy.parallel_mode_enabled retired with the parallel-mode
  // plumbing in cortex#297; surface a clear error for any leftover flag.
  const policy = raw.policy as Record<string, unknown> | undefined;
  if (policy && typeof policy === "object" && "parallel_mode_enabled" in policy) {
    offenders.push("policy.parallel_mode_enabled");
  }
  return offenders;
}

/**
 * cortex#1000 — seed-aware secure default for the `security.signing` toggle.
 *
 * Under the TC-0 (#628) posture model the schema defaults `signing` to `off`,
 * which on a seed-configured stack meant: publish unsigned AND never reject —
 * the out-of-box posture accepted envelopes whose `signed_by` stamps are
 * cryptographically meaningless (forged-stamp injection, cortex#1000). A
 * principal who went to the trouble of provisioning a signing identity almost
 * certainly wants it USED; only an explicit opt-out should disable it.
 *
 * Rule: when the raw composed config declares a non-empty
 * `stack.nkey_seed_path` AND `security.signing` is NOT explicitly set, bump
 * the raw config to `signing: "permissive"` (sign outbound + verify inbound,
 * never reject — the next-tighter mode that cannot break a working stack).
 * Every other case is untouched:
 *
 *   - no seed configured            → schema default `off` (unsigned dev
 *     stack, backward-compat invariant in `security-posture.ts`)
 *   - explicit `signing: off`       → respected (boot warns, as before)
 *   - explicit `permissive`/`enforce` → respected
 *
 * Mutates `raw.security` in place and MUST run BEFORE the Zod parse — the
 * schema's `.default("off")` makes an explicit `off` indistinguishable from
 * an unset toggle afterwards. Exported for direct unit-testing; the loader
 * call site logs the boot line when this returns `true`.
 */
export function applySeedAwareSigningDefault(
  raw: Record<string, unknown>,
): boolean {
  const stack = raw.stack;
  const seedPath =
    stack !== null && typeof stack === "object"
      ? (stack as Record<string, unknown>).nkey_seed_path
      : undefined;
  if (typeof seedPath !== "string" || seedPath.length === 0) return false;

  const security = raw.security;
  // Sage review on #1020 — only an ABSENT key or a PLAIN RECORD is mergeable.
  // A malformed `security:` (array, string, number, bare null key, Date or
  // other non-plain object, …) must reach the schema parse UNTOUCHED so it
  // fails with the schema's own error; rewriting it here would mask the
  // malformation into a valid-looking object and silently accept a config
  // that should be rejected. Plain-record = prototype is Object.prototype
  // or null (some parsers emit null-prototype mappings) — excludes Date,
  // Map, class instances (sage round 2).
  const proto =
    typeof security === "object" && security !== null
      ? (Object.getPrototypeOf(security) as object | null)
      : undefined;
  const isPlainRecord = proto === Object.prototype || proto === null;
  if (security !== undefined && !isPlainRecord) return false;
  const securityObj = isPlainRecord
    ? (security as Record<string, unknown>)
    : undefined;
  // Any explicitly-set value (including `off`, including an invalid value
  // that the schema parse will reject with its own error) wins over the
  // seed-aware default.
  if (securityObj !== undefined && "signing" in securityObj) return false;

  raw.security = { ...securityObj, signing: "permissive" };
  return true;
}

function loadCortexShape(
  raw: Record<string, unknown>,
  networks: NetworkFile[],
  surfaces: Surfaces | undefined,
): LoadedConfig {
  // v3.0.0 BREAKING (manifest PR-11) — cortex.yaml requires the canonical
  // `principal:` key. Pass the raw config straight to the schema; the
  // schema rejects a legacy `operator:`-shaped file with the
  // strip-by-default → "Invalid input: expected object" error at the
  // `principal:` slot. Principals upgrading from v2.x run
  // `cortex migrate-config <config.yaml>` to convert.
  const normalised: Record<string, unknown> = raw;

  // v2.0.0 cutover (cortex#297) — reject legacy authorisation fields with a
  // clear pointer at the migrate-config CLI BEFORE Zod's strip-by-default
  // semantics silently drop them.
  const legacyOffenders = detectLegacyAuthorisationFields(normalised);
  if (legacyOffenders.length > 0) {
    throw new Error(
      `cortex.yaml carries legacy v1.x authorisation fields no longer supported in v2.0.0:\n` +
        legacyOffenders.map((f) => `  - ${f}`).join("\n") +
        `\n\nRun \`bun src/cli/cortex/commands/migrate-config.ts <your-config.yaml>\` first to ` +
        `synthesise the new top-level \`policy:\` block (principals[] + roles[]), then re-launch cortex. ` +
        `See docs/design-policy-cutover.md §16 for the schema delta.`,
    );
  }
  // cortex#1000 — secure-by-default signing posture. A stack that configures
  // a signing seed (`stack.nkey_seed_path`) but never sets `security.signing`
  // gets `permissive` (sign outbound + verify, never reject), not the schema's
  // `off`. An EXPLICIT `signing: off` is respected — the boot path keeps
  // warning on the explicit seed-present-but-off combination. This MUST run on
  // the RAW object: after `CortexConfigSchema.parse` the schema default makes
  // an explicit `off` indistinguishable from an unset toggle.
  if (applySeedAwareSigningDefault(normalised)) {
    console.log(
      "cortex: stack signing seed configured and security.signing unset — " +
        "defaulting to signing=permissive (secure-by-default, cortex#1000); " +
        "set security.signing: off explicitly to publish unsigned",
    );
  }

  // Schema-strict parse. Any legacy field at the top level fails here with
  // the principal-friendly migration message baked into CortexConfigSchema.
  const cortexConfig: CortexConfig = CortexConfigSchema.parse(normalised);

  // cortex#1789 (S4, ADR-0024 D5) — REGISTRY pass for `renderers:`.
  // Cortex-shape configs are the only shape whose `renderers[]` got STRICT
  // per-kind validation pre-S4 (`CortexConfigSchema.renderers` used the
  // closed discriminated union); `RendererSchema` is now the loose
  // STRUCTURAL pass only (see its docstring in `cortex-config.ts`), so this
  // restores byte-identical loud-on-typo behavior for cortex.yaml at
  // config-load — using the same default in-tree registry `parseSurfaces`
  // uses above. Legacy bot.yaml `renderers[]` stays UNCHECKED here
  // (unchanged from pre-S4 — see `AgentConfigSchema.renderers`'s docstring in
  // `common/types/config.ts`): it only ever validated at `cortex.ts` boot,
  // and that asymmetry is preserved rather than newly tightened.
  const rendererRegistry = createDefaultSurfacePluginRegistry();
  for (const entry of cortexConfig.renderers) {
    resolveRendererPluginAndConfig(entry, rendererRegistry);
  }

  // CortexConfigSchema guarantees `agents.min(1)`, so [0] is always defined
  // at runtime; noUncheckedIndexedAccess still types it as possibly undefined.
  const firstAgent = cortexConfig.agents[0];
  if (firstAgent === undefined) {
    throw new Error("invariant: agents schema enforced .min(1) but [0] missing");
  }

  // Synthesize the AgentConfig `agent:` singular from principal + first agent.
  // Downstream consumers that read `config.agent.name` get the first agent's
  // id; per-instance routing flows via `inlineAgents` so the multi-agent
  // case stays correct.
  //
  // cortex#429 PR-C — `agent.operatorId` and `agent.operatorName` synthesis
  // retired alongside the schema fields. Downstream consumers (cortex.ts,
  // myelin runtime) now read the principal identity directly from
  // `LoadedConfig.principal.id` (returned below) and the helpers that
  // accept it as a parameter.
  //
  // `principal.id` and `principal.dataResidency` are non-optional after parse
  // (required + default respectively), so prior `!== undefined` guards
  // were dead conditions.
  const synthesizedAgent = {
    name: firstAgent.id,
    displayName: firstAgent.displayName,
    // v2.0.0 cutover (cortex#297) — `operator*Id` fields retired from
    // AgentConfig.agent. Principal's platform-side ids surface through
    // `LoadedConfig.principal` (see return value below); the boot path in
    // cortex.ts reads them from there.
    dataResidency: cortexConfig.principal.dataResidency,
    personaFile: firstAgent.persona,
  };

  // Flatten per-agent presence blocks into legacy flat arrays. Each entry
  // carries a synthesized `instanceId` matching MIG-7.2c's post-collapse
  // convention so `system.adapter.*` envelope ids stay stable.
  const discord = flattenDiscordPresences(cortexConfig.agents);
  const mattermost = flattenMattermostPresences(cortexConfig.agents);
  const slack = flattenSlackPresences(cortexConfig.agents);

  // Build the merged AgentConfig-shaped object. Networks behave the same
  // way they do in the legacy path; renderers + nats + the *Config blocks
  // are passthrough.
  const merged: Record<string, unknown> = {
    agent: synthesizedAgent,
    discord,
    mattermost,
    slack,
    networks,
    networksDir: cortexConfig.networksDir,
    renderers: cortexConfig.renderers,
    claude: cortexConfig.claude,
    attachments: cortexConfig.attachments,
    execution: cortexConfig.execution,
    // cortex#1792 (S6, ADR-0024 D3/OQ6/OQ9) — carry `plugins.external`
    // through to the synthesized AgentConfig. Same failure class the
    // `security`/`mc`/`cockpit`/`grove` comments above warn about: omitting
    // this passthrough would silently re-default `plugins.external` to
    // `false` for every cortex-shape deployment even when the principal
    // explicitly declared `plugins: {external: true}` in `cortex.yaml` —
    // masking, not just defaulting, the principal's own opt-in.
    plugins: cortexConfig.plugins,
    github: cortexConfig.github,
    paths: cortexConfig.paths,
    // TC-0 (#628) — carry the principal-declared security posture through to
    // the synthesized AgentConfig so `resolveSigningKnobs` at boot reads the
    // cortex.yaml `security:` block. Always defined (schema transform fills
    // defaults), so this is a plain passthrough — omitting it would silently
    // default the posture to `off` for every cortex-shape deployment.
    security: cortexConfig.security,
    // MC-I1 (ADR-0005, fix/c-844) — carry the cockpit + in-process MC config
    // through to the synthesized AgentConfig. Both are now on CortexConfigSchema
    // (shared McSchema/CockpitSchema), so they survive the strip-by-default
    // parse; without these passthroughs `AgentConfigSchema.parse(merged)` would
    // re-default them to `enabled: false` and MC would never boot on any
    // cortex-shape deployment (same failure mode the `security` comment warns of).
    mc: cortexConfig.mc,
    cockpit: cortexConfig.cockpit,
    // F-11 (fix/c-844) — carry the grove block (Discord push toggle + dashboard
    // deep-link baseUrl) through to the synthesized AgentConfig. Now on
    // CortexConfigSchema (shared GroveSchema), so it survives the
    // strip-by-default parse; without this passthrough `AgentConfigSchema.parse(
    // merged)` would re-default `grove.baseUrl` to "" and every attention-
    // notification deep-link on a cortex-shape stack would fall back to localhost.
    grove: cortexConfig.grove,
    ...(cortexConfig.nats !== undefined && { nats: cortexConfig.nats }),
  };

  return {
    config: AgentConfigSchema.parse(merged),
    inlineAgents: [...cortexConfig.agents],
    // v2.0.0 (cortex#297) — surface principal platform ids for the boot path.
    principal: {
      id: cortexConfig.principal.id,
      ...(cortexConfig.principal.displayName !== undefined && {
        displayName: cortexConfig.principal.displayName,
      }),
      ...(cortexConfig.principal.discordId !== undefined && {
        discordId: cortexConfig.principal.discordId,
      }),
      ...(cortexConfig.principal.mattermostId !== undefined && {
        mattermostId: cortexConfig.principal.mattermostId,
      }),
      ...(cortexConfig.principal.slackId !== undefined && {
        slackId: cortexConfig.principal.slackId,
      }),
    },
    // IAW A.5.3 — surface the validated `stack:` block to the boot path.
    // Always carry-through (even when undefined) keeps callers' destructuring
    // simple: `const { stack } = loadConfigWithAgents(path)` is safe whether
    // or not the principal declared the block.
    ...(cortexConfig.stack !== undefined && { stack: cortexConfig.stack }),
    // IAW C.3.1 — same pattern for the `policy:` block. Surfaced raw so
    // the boot path passes it to `policyEngineFromConfig` once. The
    // schema layer (PolicySchema.superRefine) has already enforced
    // cross-references + uniqueness, so this is a pure carry-through.
    ...(cortexConfig.policy !== undefined && { policy: cortexConfig.policy }),
    bus: cortexConfig.bus,
    // IAW GW, cortex#524 — surface the validated `surfaces:` binding map to
    // the boot path. Captured before foldSurfaceBindings drops the top-level
    // key; undefined when the input declared no surfaces block. The gateway
    // bootstrap (`maybeCreateSurfaceGateway`) reads this at boot.
    ...(surfaces !== undefined && { surfaces }),
    // F-6 — carry through the reflex activation bridge block (empty-default
    // applied by the schema, so always present for cortex-shape input).
    reflexActivation: cortexConfig.reflex_activation,
    // F-6 downstream — carry through the notify block (notify.discord etc.).
    notify: cortexConfig.notify,
  };
}

/**
 * Convert each agent's optional Discord presence into a flat AgentConfig
 * discord entry. Empty when no agent has Discord presence.
 *
 * The synthesized `instanceId` matches the MIG-7.2c default convention —
 * `${agent.id}-discord` with no guild suffix (one presence per agent in
 * cortex shape). This keeps `system.adapter.*` envelope ids stable across
 * the schema flip; principals who grep for the old `{agentName}-discord-{guildId}`
 * pattern will see the collapsed form once cortex.yaml is in effect.
 */
export function flattenDiscordPresences(agents: readonly Agent[]) {
  const out: (DiscordPresence & { instanceId: string })[] = [];
  for (const a of agents) {
    const p = a.presence.discord;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-discord` });
  }
  return out;
}

export function flattenMattermostPresences(agents: readonly Agent[]) {
  const out: (MattermostPresence & { instanceId: string })[] = [];
  for (const a of agents) {
    const p = a.presence.mattermost;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-mattermost` });
  }
  return out;
}

/**
 * Convert each agent's optional Slack presence into a flat AgentConfig
 * slack entry. Mirror of `flattenDiscordPresences` /
 * `flattenMattermostPresences` — empty when no agent declares a
 * `presence.slack` block.
 */
export function flattenSlackPresences(agents: readonly Agent[]) {
  const out: (SlackPresence & { instanceId: string })[] = [];
  for (const a of agents) {
    const p = a.presence.slack;
    if (!p) continue;
    out.push({ ...p, instanceId: `${a.id}-slack` });
  }
  return out;
}

/**
 * cortex#1217 — the boot adapter loop's "should this surface instance start?"
 * gate, extracted so the no-fail-open guarantee is a SHARED, tested unit rather
 * than three inline `!instance.enabled` checks. The per-platform
 * adapter-construction loops in `src/cortex.ts` (discord / mattermost / slack)
 * each `continue` past an instance for which this returns `false` BEFORE
 * constructing the adapter or calling `connect()`. A surface disabled by
 * fail-soft surface-token degradation (`resolveAgentPresenceTokens` →
 * `enabled: false`) is carried through the presence-flatten, so this predicate
 * is exactly what stops a missing-secret surface from ever opening a connection.
 */
export function surfaceInstanceEnabled(instance: { enabled: boolean }): boolean {
  return instance.enabled;
}

// =============================================================================
// F-2 — agents.d/ fragment loader
// =============================================================================

/**
 * Error raised when a fragment in `agents.d/` fails to load. Carries the
 * file path so the caller can name it in principal-facing error messages.
 *
 * Boot-time strict-failure rule (cortex#60 spec §FR-4): cortex must refuse
 * to start if any fragment fails. Mid-run rule (FR-5): caller catches and
 * keeps prior valid state alive.
 */
export class FragmentLoadError extends Error {
  public readonly file: string;
  public readonly reason: string;

  constructor(file: string, reason: string, cause?: Error) {
    super(`fragment ${file}: ${reason}`);
    this.name = "FragmentLoadError";
    this.file = file;
    this.reason = reason;
    if (cause) (this as { cause?: Error }).cause = cause;
  }
}

/**
 * Load all `*.yaml` / `*.yml` fragments from `dir` as Agent definitions.
 * Returns the agents in alphabetical filename order.
 *
 * Each fragment must parse as a single YAML document conforming to
 * `AgentSchema`. The `persona:` path is resolved relative to `dir` (or used
 * as-is if absolute); `~` is expanded to `$HOME`. The function checks the
 * persona file exists on disk and surfaces a `FragmentLoadError` if not.
 *
 * Returns `[]` if `dir` does not exist (principal hasn't created it yet).
 * Skips non-yaml files and dotfiles silently. Duplicate `id` across fragments
 * triggers `FragmentLoadError` naming both filenames + the conflicting id.
 *
 * This function does NOT resolve trust references — callers wrap the merged
 * Agent list in `AgentRegistry` (`src/common/agents/registry.ts`) which
 * throws `UnknownAgentReferenceError` on unresolved trust at construction.
 */
/**
 * Load and validate a single fragment file. Extracted from `loadAgentsDirectory`
 * (Echo M2 on cortex#63) so consumers like the CLI's `--fragment` mode get
 * the same hardening: 1 MiB size cap, ENOENT race handling, schema validation,
 * filename-stem warning, persona-path resolution + existence check.
 *
 * `personaBaseDir` is the directory relative paths in `agent.persona` resolve
 * against — typically the fragment's own directory.
 *
 * Returns `null` if the file vanished between caller's directory-listing and
 * this call (ENOENT race). The directory loader skips such files; single-file
 * callers translate `null` into a clear "file disappeared" error.
 */
export function loadAgentFromFile(
  filePath: string,
  personaBaseDir: string,
  warnings?: SurfaceTokenWarning[],
): Agent | null {
  // Echo M3 — size guard before readFileSync.
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new FragmentLoadError(
      filePath,
      `stat failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }
  if (size > FRAGMENT_MAX_BYTES) {
    throw new FragmentLoadError(
      filePath,
      `fragment exceeds ${FRAGMENT_MAX_BYTES} bytes (got ${size}); refusing to read`,
    );
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new FragmentLoadError(
      filePath,
      `read failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    throw new FragmentLoadError(
      filePath,
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined,
    );
  }

  // Echo N6 — principal-UX warn when id and filename stem disagree.
  const filename = basename(filePath);
  const filenameStem = basename(filename, filename.endsWith(".yml") ? ".yml" : ".yaml");
  if (raw && typeof raw === "object" && "id" in raw) {
    const declaredId = (raw as { id?: unknown }).id;
    if (typeof declaredId === "string" && declaredId !== filenameStem) {
      console.warn(
        `agents-loader: fragment ${filename} declares id "${declaredId}" which differs from its filename stem "${filenameStem}". Convention is to match — principal tooling (arc, cortex agents list) keys on the id, but mismatch obscures filesystem lookup.`,
      );
    }
  }

  // cortex#1209 — resolve `__ENV__` placeholders in this fragment's surface
  // secret tokens (`presence.{discord.token, mattermost.apiToken,
  // slack.botToken/appToken}`) BEFORE the schema parse. agents.d/ fragments
  // (e.g. Pier's `presence.discord.token: __PIER_BOT_TOKEN__`) do NOT pass
  // through `composeRawConfig`, so they get the same fail-closed, never-on-disk
  // resolution here. A pure raw record is required; non-object raw falls
  // straight to AgentSchema.parse which raises the principal-friendly error.
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    // cortex#1217 — pass the warnings sink so a fragment agent's disabled
    // surface (vega ships `presence.discord.token: __VEGA_BOT_TOKEN__` as an
    // agents.d/ fragment) is COLLECTED, not just emitted to stderr — the boot
    // path threads these into the consolidated disabled-surface banner.
    resolveAgentPresenceTokens(raw as Record<string, unknown>, filename, warnings);
  }

  let agent: Agent;
  try {
    agent = AgentSchema.parse(raw);
  } catch (err: unknown) {
    const issues = (err as { issues?: { path?: unknown[]; message: string }[] }).issues ?? [];
    const details =
      issues.length > 0
        ? issues.map((i) => `  ${(i.path ?? []).join(".")}: ${i.message}`).join("\n")
        : err instanceof Error
          ? err.message
          : String(err);
    throw new FragmentLoadError(
      filePath,
      `schema validation failed:\n${details}`,
      err instanceof Error ? err : undefined,
    );
  }

  // Resolve persona path: ~ FIRST (so a `~/personas/foo.md` is fully
  // expanded before isAbsolute check), then relative → absolute against
  // the fragment's directory. Echo B1 fix: must expand BEFORE join.
  const personaPathExpanded = expandTilde(agent.persona);
  const personaPathResolved = isAbsolute(personaPathExpanded)
    ? personaPathExpanded
    : resolve(personaBaseDir, personaPathExpanded);

  if (!existsSync(personaPathResolved)) {
    throw new FragmentLoadError(
      filePath,
      `persona file does not exist: ${personaPathResolved}`,
    );
  }

  return { ...agent, persona: personaPathResolved };
}

export function loadAgentsDirectory(dir: string, warnings?: SurfaceTokenWarning[]): Agent[] {
  const expandedDir = expandTilde(dir);

  if (!existsSync(expandedDir)) {
    return [];
  }

  const files = listYamlFiles(expandedDir);

  const agents: Agent[] = [];
  const seenIds = new Map<string, string>();

  for (const filename of files) {
    const filePath = join(expandedDir, filename);
    // cortex#1217 — thread the sink so fragment-agent disabled-surface warnings
    // reach the boot banner (deduped at the call site like the inline path).
    const agent = loadAgentFromFile(filePath, expandedDir, warnings);
    if (agent === null) {
      // File vanished between readdir and read — skip silently.
      continue;
    }

    if (seenIds.has(agent.id)) {
      throw new FragmentLoadError(
        filePath,
        `duplicate agent id "${agent.id}" — also defined in ${seenIds.get(agent.id)}`,
      );
    }
    seenIds.set(agent.id, filename);
    agents.push(agent);
  }

  return agents;
}

function loadNetworkFiles(networksDir: string, explicit: boolean): NetworkFile[] {
  if (!existsSync(networksDir)) {
    if (explicit) {
      // Principal pointed networksDir at a non-default path that doesn't
      // exist — surface loudly so they notice the typo / missing mount.
      console.warn(`config-loader: networksDir "${networksDir}" does not exist — no networks loaded`);
    } else {
      // cortex#88 item 7: the default path is absent. This is fine —
      // networks/ is optional today — but surface at info-level so
      // a principal who actually expected fragments to load can spot
      // the path mismatch.
      console.info(`config-loader: default networksDir "${networksDir}" not present — no networks loaded (this is fine if you haven't created any network fragments)`);
    }
    return [];
  }

  const files = listYamlFiles(networksDir);

  const networks: NetworkFile[] = [];
  const seenIds = new Map<string, string>();

  for (const filename of files) {
    const filePath = join(networksDir, filename);
    const content = readFileSync(filePath, "utf-8");

    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch (err) {
      throw new Error(
        `Failed to parse network file ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let network: NetworkFile;
    try {
      network = NetworkFileSchema.parse(raw);
    } catch (err) {
      // Zod errors expose either `.issues` (v4) or `.errors` (v3) — narrow
      // via runtime feature-detection without `any`.
      const zodIssues = isZodLikeError(err) ? (err.issues ?? err.errors ?? []) : [];
      const details = zodIssues
        .map((i) => `  ${i.path?.join(".") ?? "?"}: ${i.message}`)
        .join("\n");
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Validation error in ${filename}:\n${details !== "" ? details : message}`,
        { cause: err },
      );
    }

    if (seenIds.has(network.id)) {
      throw new Error(`Duplicate network ID "${network.id}" found in ${filename} and ${seenIds.get(network.id)}`);
    }
    seenIds.set(network.id, filename);
    networks.push(network);
  }

  return networks;
}

function hasLegacyCloudConfig(raw: Record<string, unknown>): boolean {
  const api = raw.api as Record<string, unknown> | undefined;
  return !!(api?.endpoint && api.apiKey);
}

function buildLegacyNetwork(raw: Record<string, unknown>): NetworkFile {
  const api = raw.api as Record<string, unknown>;
  const agent = raw.agent as Record<string, unknown> | undefined;

  // R2.I (cortex#436) — the cloud-network principal-identity field is now
  // `principalId`. This legacy reader still accepts the legacy flat keys
  // (`api.operatorId` / grove-v2 `agent.operatorId`) and rewrites them into
  // the canonical cloud `principalId` when synthesising the default network,
  // mirroring the R3 legacy-reader pattern.
  const principalId = (api.operatorId ?? (agent ? agent.operatorId : undefined)) as string | undefined;
  if (!principalId) {
    console.warn(
      "config-loader: no principal id configured (api.operatorId or agent.operatorId). " +
      "Skipping cloud config for legacy default network to avoid phantom dashboard entries.",
    );
  }

  const cloud: Record<string, unknown> | undefined = principalId ? {
    endpoint: api.endpoint as string,
    apiKey: api.apiKey as string,
    principalId,
    ...(api.cfAccessClientId ? { cfAccessClientId: api.cfAccessClientId } : {}),
    ...(api.cfAccessClientSecret ? { cfAccessClientSecret: api.cfAccessClientSecret } : {}),
  } : undefined;
  const network: Record<string, unknown> = { id: "default" };
  if (cloud) network.cloud = cloud;

  if (raw.discord) network.discord = raw.discord;
  if (raw.mattermost) network.mattermost = raw.mattermost;
  if (raw.github) network.github = raw.github;

  const claude = raw.claude as Record<string, unknown> | undefined;
  if (claude) {
    const nc: Record<string, unknown> = {};
    if (claude.allowedDirs) nc.allowedDirs = claude.allowedDirs;
    if (claude.readOnlyDirs) nc.readOnlyDirs = claude.readOnlyDirs;
    if (claude.disallowedTools) nc.disallowedTools = claude.disallowedTools;
    if (claude.bashAllowlist) nc.bashAllowlist = claude.bashAllowlist;
    if (Object.keys(nc).length > 0) network.claude = nc;
  }

  if (agent) {
    const op: Record<string, unknown> = {};
    if (agent.operatorDiscordId) op.operatorDiscordId = agent.operatorDiscordId;
    if (agent.operatorMattermostId) op.operatorMattermostId = agent.operatorMattermostId;
    if (Object.keys(op).length > 0) network.operator = op;
  }

  return NetworkFileSchema.parse(network);
}
