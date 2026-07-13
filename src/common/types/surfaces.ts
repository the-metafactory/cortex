/**
 * IAW CFG.c — the `surfaces.yaml` layer schema + the binding-fold helper.
 *
 * CFG.c moves the per-platform **surface bindings** (Discord/Slack/Mattermost
 * `token`, `guild`, channel/instance bindings) out of each stack's
 * `agents[*].presence.{platform}` block and into a top-level `surfaces.yaml`
 * layer. This is the file the shared surface gateway (GW, §13.2) consumes: it
 * is the `{surface-instance → stack}` binding map — the single place that says
 * "this platform credential/instance belongs to this stack's agent".
 *
 * It is a **source-layout change, not a runtime-shape change**. The composer
 * (`composeRawConfig`) reads `surfaces/surfaces.yaml`, folds each binding back
 * into the matching `agents[*].presence.{platform}` block of the raw config,
 * and drops the `surfaces:` key — so by the time the existing
 * `loadCortexShape` parse/flatten runs, the raw object is **identical** to the
 * inline (pre-CFG.c) form. `LoadedConfig` is byte-identical; every consumer
 * (`src/cortex.ts` per-presence-token wiring, the per-stack adapters) keeps
 * working unchanged.
 *
 * The fold is **additive and optional**: a config with NO `surfaces.yaml` (the
 * three live deployments — `cortex.yaml` / `cortex.work.yaml` /
 * `cortex.halden.yaml` carry bindings inline in per-stack presence) loads
 * unchanged via the fallback. Per-stack presence is always the fallback;
 * `surfaces.yaml` is layered on top.
 *
 * =============================================================================
 * The binding map shape (GW precondition — CFG.c.3)
 * =============================================================================
 *
 * ```yaml
 * surfaces:
 *   discord:
 *     - agent: ivy            # which agent's presence.discord this binding fills
 *       stack: andreas/research   # OPTIONAL — the target stack id (GW {instance → stack})
 *       binding:              # the per-platform binding/credential fields
 *         token: REPLACE_WITH_DISCORD_BOT_TOKEN
 *         guildId: "000000000000000000"
 *         agentChannelId: "000000000000000000"
 *         logChannelId: "000000000000000000"
 *   slack:
 *     - agent: ivy
 *       binding:
 *         botToken: xoxb-...
 *         appToken: xapp-...
 *         workspaceId: T01234567
 *   mattermost:
 *     - agent: ivy
 *       binding:
 *         apiUrl: https://mm.example.com
 *         apiToken: ...
 * ```
 *
 * - **Key**: platform (`discord` | `slack` | `mattermost`).
 * - **`agent`**: the agent id whose `presence.{platform}` block this binding
 *   fills. This is the join key against `stacks/*.yaml` `agents[].id`.
 * - **`stack`**: OPTIONAL `{principal}/{stack}` id — the surface-instance ↔
 *   stack binding the GW routes on (`{instance → stack}`). Carried verbatim so
 *   the gateway can build its routing table; the composer does not consume it
 *   when folding (the agent id is the fold key within the composed raw config).
 * - **`binding`**: the per-platform credential/instance fields — exactly the
 *   subset of `{Discord,Slack,Mattermost}PresenceSchema` that constitutes the
 *   surface binding (the dangerous tokens + the guild/workspace/channel ids).
 *   These are merged onto the agent's existing `presence.{platform}` block
 *   (binding wins on leaf keys), so a stack file may still carry the
 *   non-binding presence knobs (`contextDepth`, `surfaceSubjects`, …) inline.
 *
 * Why `binding` is a nested sub-object rather than flat: it draws a crisp line
 * between the **binding** the GW owns (and resolves per instance) and the rest
 * of the presence block the stack owns. The GW reads `surfaces.{platform}[].binding`
 * for the connection; the stack keeps the render knobs.
 */

import { z } from "zod/v4";

import { LETTER_PREFIX_ID_REGEX } from "./id";
import { isPlainObject } from "./object-guards";
// cortex#1794 (S9 MOVE) — the Web/SSE binding schema left this repo entirely:
// it now lives in the `metafactory-cortex-adapter-web` bundle's own
// `src/schema.ts` (plugin-owned data, S4's principle), loaded at boot by
// `src/adapters/loader.ts` and carried on the registered `AdapterPlugin`'s
// `bindingSchema` field — never imported back into cortex core. `web` is no
// longer one of the hardcoded platforms below; it validates like any other
// registry-contributed platform (generic `SurfaceBindingEntrySchema` at the
// STRUCTURAL pass, the plugin's own `bindingSchema` at the REGISTRY pass —
// see `SurfacesSchema`'s doc comment).

// =============================================================================
// Per-platform binding schemas — the credential/instance subset that moves
// =============================================================================
//
// These intentionally mirror the binding-bearing fields of the matching
// `*PresenceSchema` in `cortex-config.ts`. They are deliberately PERMISSIVE
// supersets (`.passthrough()` is avoided — see below) of the required binding
// fields: the schema's job here is to validate the REQUIRED binding fields
// (CFG.c.4) are present and well-typed. The full presence validation still
// happens downstream when the folded raw config is parsed by
// `CortexConfigSchema` — so any binding field also re-validates against the
// canonical presence schema after the fold. Keeping the binding schemas as
// supersets (required fields + open `.catchall`) means a stack can put any
// presence-shaped knob under `binding` and have it folded; the canonical
// presence schema is the final arbiter.

/**
 * Discord surface binding — the connection-defining subset of
 * `DiscordPresenceSchema`. `token` + `guildId` are the irreducible binding;
 * the channel ids are the instance's render targets. `catchall(z.unknown())`
 * lets any other presence field (e.g. `contextDepth`, `trustedBotIds`,
 * `surfaceSubjects`) ride along under `binding` and fold through — the
 * canonical `DiscordPresenceSchema` validates them post-fold.
 */
export const DiscordBindingSchema = z
  .object({
    token: z.string().min(1, "surfaces.discord[].binding.token is required"),
    guildId: z.coerce.string().min(1, "surfaces.discord[].binding.guildId is required"),
    agentChannelId: z.coerce
      .string()
      .min(1, "surfaces.discord[].binding.agentChannelId is required"),
    logChannelId: z.coerce
      .string()
      .min(1, "surfaces.discord[].binding.logChannelId is required"),
  })
  .catchall(z.unknown());

/**
 * Slack surface binding — `botToken` + `appToken` + `workspaceId` are the
 * irreducible Socket-Mode binding (mirror of `SlackPresenceSchema`). Regexes
 * match the canonical presence schema so a malformed token fails at the
 * surfaces layer, not only post-fold.
 */
export const SlackBindingSchema = z
  .object({
    botToken: z
      .string()
      .regex(/^xoxb-/, "surfaces.slack[].binding.botToken must be a bot user OAuth token (xoxb-...)"),
    appToken: z
      .string()
      .regex(/^xapp-/, "surfaces.slack[].binding.appToken must be an app-level token (xapp-...)"),
    workspaceId: z.coerce
      .string()
      .regex(
        /^T[A-Z0-9]{8,16}$/,
        "surfaces.slack[].binding.workspaceId must be a Slack team id (T... with 8-16 trailing chars)",
      ),
  })
  .catchall(z.unknown());

// cortex#1796 (S11 MOVE) — the Mattermost binding schema left this repo
// entirely: it now lives in the `metafactory-cortex-adapter-mattermost`
// bundle's own `src/schema.ts` (plugin-owned data, S4's principle), loaded
// at boot by `src/adapters/loader.ts` and carried on the registered
// `AdapterPlugin`'s `bindingSchema` field — never imported back into cortex
// core. `mattermost` is no longer one of the hardcoded platforms below (see
// `WebBindingSchema`'s cortex#1794 S9 MOVE for the precedent this mirrors);
// it validates like any other registry-contributed platform (generic
// `SurfaceBindingEntrySchema` at the STRUCTURAL pass, the plugin's own
// `bindingSchema` at the REGISTRY pass — see `SurfacesSchema`'s doc
// comment below). It still FOLDS into `agents[*].presence.mattermost` (see
// {@link DEFAULT_FOLD_PLATFORMS}) — extraction moved the CODE, not the
// legacy presence-fold behavior.

// =============================================================================
// Binding entry — one surface-instance bound to one stack's agent
// =============================================================================

/** Common fields on every per-platform binding entry. */
const bindingEntryBase = {
  /**
   * The agent id whose `presence.{platform}` block this binding fills — the
   * join key against `stacks/*.yaml` `agents[].id`. Same id grammar as
   * `AgentSchema.id` (letter-prefixed lowercase alphanumeric + hyphen).
   */
  agent: z.string().regex(
    LETTER_PREFIX_ID_REGEX,
    "surfaces[].agent must be a valid agent id (lowercase alphanumeric + hyphen, starting with a letter) matching an agents[].id in the stack",
  ),
  /**
   * OPTIONAL `{principal}/{stack}` id — the surface-instance ↔ stack binding
   * the GW routes on. Carried verbatim for the gateway's `{instance → stack}`
   * routing table; the composer does not consume it when folding (the agent
   * id is the fold key). Validated loosely as a non-empty string here — the
   * canonical stack-id grammar lives in `StackConfigSchema.id` and is GW's to
   * resolve.
   */
  stack: z.string().min(1).optional(),
};

export const DiscordSurfaceBindingSchema = z.object({
  ...bindingEntryBase,
  binding: DiscordBindingSchema,
});

export const SlackSurfaceBindingSchema = z.object({
  ...bindingEntryBase,
  binding: SlackBindingSchema,
});

// `MattermostSurfaceBindingSchema` — cortex#1796 (S11 MOVE) dropped: no
// longer one of the hardcoded per-platform binding schemas (see the module
// doc above). `surfaces.mattermost[]` now validates via the generic
// {@link SurfaceBindingEntrySchema} catchall, same as `web`.

/**
 * cortex#1789 (S4, ADR-0024 D5) — the generic STRUCTURAL binding entry.
 * Every `surfaces.{platform}[]` entry is `{agent, stack?, binding}` — this is
 * the shape any REGISTERED-OR-NOT platform key must satisfy at the structural
 * pass. `binding` is intentionally a loose record here (not one of the
 * per-platform binding schemas above): the structural pass's job is "is this
 * shaped like a binding entry", not "is this a valid Discord/Slack/Mattermost/
 * Web binding" — that per-platform check is the REGISTRY pass
 * ({@link resolveAdapterPluginOrThrow} in `src/adapters/registry.ts`), which
 * runs once a `SurfacePluginRegistry` is in hand and knows which plugin's
 * `bindingSchema` applies to which key.
 */
export const SurfaceBindingEntrySchema = z
  .object({
    ...bindingEntryBase,
    binding: z.record(z.string(), z.unknown()),
  })
  .strict();

export type SurfaceBindingEntry = z.infer<typeof SurfaceBindingEntrySchema>;

// =============================================================================
// Top-level `surfaces:` block
// =============================================================================

/**
 * The `surfaces:` block — the binding map. Keyed by platform; each platform
 * holds a list of `{agent, stack?, binding}` entries. All platforms are
 * optional (a deployment may bind only Discord).
 *
 * cortex#1789 (S4, ADR-0024 D5) — two-stage validation. This schema is the
 * STRUCTURAL pass ONLY: the two REMAINING in-tree platforms (discord/slack)
 * keep their full, strongly-typed binding schemas (byte-identical validation,
 * zero ripple to every consumer typed against `Surfaces["discord"]` etc. —
 * `discord-token-groups.ts`, `gateway-adapters.ts`); any OTHER top-level key
 * — including `web` (cortex#1794 S9 MOVE) and `mattermost` (cortex#1796 S11
 * MOVE), both extracted out-of-tree and no longer among the hardcoded set —
 * is accepted structurally as a generic {@link SurfaceBindingEntrySchema}
 * array via `.catchall(...)`, because a registry-contributed platform's key
 * is not known to this static schema. `.catchall()` replaces the old
 * `.strict()` — the "is this a REAL platform" check moves to the REGISTRY
 * pass (`resolveAdapterPluginOrThrow` / `validateSurfacesAgainstRegistry`,
 * `src/adapters/registry.ts`), which runs wherever a `SurfacePluginRegistry`
 * is in hand (the in-tree `createDefaultSurfacePluginRegistry` plus whatever
 * `loadExternalPlugins` registered, e.g. `web`/`mattermost` once their
 * bundles load) and produces the SAME loud "no adapter installed for
 * platform …" failure a typo (`discrod:`) used to get from `.strict()` —
 * see `loader.ts`'s `parseSurfaces` and `cortex.ts` boot for the two call
 * sites.
 *
 * Note: `web[]` bindings are NOT folded by `foldSurfaceBindings` (there is no
 * legacy presence shape) — see {@link DEFAULT_FOLD_PLATFORMS}. `mattermost[]`
 * bindings DO still fold (legacy `agents[*].presence.mattermost` shape
 * predates this extraction) — extraction moved the plugin CODE out-of-tree,
 * not the fold behavior.
 */
export const SurfacesSchema = z
  .object({
    discord: z.array(DiscordSurfaceBindingSchema).optional(),
    slack: z.array(SlackSurfaceBindingSchema).optional(),
  })
  // `.optional()` on the catchall element too — NOT a behavior change (a
  // catchall key, when actually present in the input, is never `undefined`
  // at runtime; Zod simply omits an absent key rather than storing
  // `undefined` under it). This is purely so the inferred TS type's index
  // signature (`X[] | undefined`) matches the explicit `.optional()`
  // keys above — TypeScript requires an object's named-optional-property
  // type to be assignable to its own index-signature type, and `X[] | undefined`
  // vs a non-optional `X[]` catchall would otherwise conflict
  // ("Property 'discord' is incompatible with index signature").
  .catchall(z.array(SurfaceBindingEntrySchema).optional());

export type Surfaces = z.infer<typeof SurfacesSchema>;
export type DiscordSurfaceBinding = z.infer<typeof DiscordSurfaceBindingSchema>;
export type SlackSurfaceBinding = z.infer<typeof SlackSurfaceBindingSchema>;
// `MattermostSurfaceBinding`/`MattermostBindingSchema` — cortex#1796 (S11
// MOVE), and `WebSurfaceBinding`/`WebBinding`/`WebBindingSchema` — cortex#1794
// (S9 MOVE) — both extracted entirely to their own bundles; no longer defined
// or re-exported from cortex core (see the module doc above).

/**
 * cortex#1796 (S11 MOVE) — platforms extracted out-of-tree via the
 * first-party ADAPTER bundle exemption (ADR-0024 D2/S9a). The SYNCHRONOUS
 * in-tree registry (`createDefaultSurfacePluginRegistry()`, used at
 * config-load time — BEFORE `loadExternalPlugins`' async bundle discovery
 * runs) has no entry for either. `common/config/loader.ts`'s `parseSurfaces`
 * uses this set to admit `surfaces.{platform}[]` structurally at config-load
 * time (deferring the REAL per-field `bindingSchema` check to boot, once the
 * bundle has actually loaded) instead of rejecting a legitimately-declared
 * platform as an unregistered typo. This is a registry-free anchor, same
 * spirit as {@link DEFAULT_FOLD_PLATFORMS} — a genuinely unknown/misspelled
 * platform key (anything NOT in this set and NOT discord/slack) still fails
 * loudly at config-load, and `cortex.ts`'s boot sequence re-validates every
 * platform (including these two) against the FULLY-LOADED registry after
 * `loadExternalPlugins` completes, so a bundle that fails to load (bad
 * manifest, sdk mismatch, …) still surfaces a loud failure — just at boot,
 * not at config-parse.
 */
export const EXTRACTED_ADAPTER_PLATFORMS = ["web", "mattermost"] as const;

// =============================================================================
// The fold — surfaces.yaml bindings → agents[*].presence.{platform}
// =============================================================================

/**
 * cortex#1789 (S4, ADR-0024 D5) — the default fold-platform list, byte-
 * identical to the pre-S4 hardcoded `PLATFORMS` const. `web` is deliberately
 * absent — it never folded even when in-tree (no legacy presence shape
 * exists for it), and cortex#1794 (S9 MOVE) removed it from this module
 * entirely besides. This is the FALLBACK `foldSurfaceBindings` uses when
 * called with no explicit `foldPlatforms` — every existing call site (both
 * `loader.ts` composer paths, every test) keeps this exact behavior.
 * `loader.ts` additionally computes this list from the registry
 * (`registry.listAdapters().filter(p => p.foldsIntoPresence)`) and passes it
 * explicitly — the registry-derived list and this constant agree today
 * because every in-tree `AdapterPlugin` sets `foldsIntoPresence` to match
 * (discord/slack/mattermost `true`; `web`, wherever it's registered from,
 * `false`). `surfaces.ts` itself does NOT import the registry
 * (`src/adapters/registry.ts` transitively imports this module for
 * `DiscordBindingSchema`/`SlackBindingSchema`/etc — importing the registry
 * back here would cycle), so this constant is the registry-free anchor the
 * registry-derived list is checked against.
 */
export const DEFAULT_FOLD_PLATFORMS = ["discord", "slack", "mattermost"] as const;

/**
 * CFG.c.1/CFG.c.2 — fold a `surfaces:` block into the composed raw config's
 * `agents[*].presence.{platform}` blocks, returning a NEW raw object with the
 * top-level `surfaces:` key removed.
 *
 * Called by `composeRawConfig` AFTER the directory layers are deep-merged and
 * BEFORE the result is handed to the parse/flatten path. The result is the
 * exact shape the inline (pre-CFG.c) config produced — so `LoadedConfig` is
 * unchanged and no consumer is touched.
 *
 * `foldPlatforms` — cortex#1789 (S4): the set of platform keys that fold into
 * `agents[*].presence.{platform}`. Defaults to {@link DEFAULT_FOLD_PLATFORMS}
 * (byte-identical to the pre-S4 hardcoded list) so every existing caller is
 * unaffected; `loader.ts` passes the REGISTRY-DERIVED list explicitly
 * (`AdapterPlugin.foldsIntoPresence`), making "which platforms fold" a
 * property each plugin declares rather than a second hardcoded list that can
 * drift from the registry (`web` NOT folding is preserved exactly either way).
 *
 * Resolution / precedence (the design fork called out in CFG.c):
 *
 *   - The binding's `agent` field is matched against `agents[].id` in the
 *     composed raw config. The binding is merged onto that agent's
 *     `presence.{platform}` block, **binding fields winning on leaf keys**
 *     (the surfaces.yaml layer is the more-specific surface-of-truth for the
 *     credential/instance fields, layered on top of any inline presence the
 *     stack file declared). A stack may therefore keep non-binding presence
 *     knobs (`contextDepth`, `surfaceSubjects`) inline and let surfaces.yaml
 *     own only the binding — the two merge.
 *   - If the agent has no `presence.{platform}` block yet, one is created from
 *     the binding alone.
 *   - **No matching agent → loud error.** A binding that names an agent absent
 *     from every stack is almost certainly a typo or a stale binding; failing
 *     loudly beats silently dropping a credential (which would leave the agent
 *     dark with no diagnostic).
 *
 * `surfaces` absent or empty → `raw` returned unchanged (minus a no-op clone),
 * which is the fallback path the three live single-presence configs take.
 *
 * The function does NOT mutate its input (pure fold — idempotent re-composition
 * yields the same object, matching `deepMerge`'s contract).
 */
export function foldSurfaceBindings(
  raw: Record<string, unknown>,
  foldPlatforms: readonly string[] = DEFAULT_FOLD_PLATFORMS,
): Record<string, unknown> {
  const surfacesRaw = raw.surfaces;
  if (surfacesRaw === undefined || surfacesRaw === null) {
    // No surfaces layer — per-stack presence is the fallback. Nothing to fold.
    return raw;
  }

  // Validate the binding map loudly (CFG.c.4 — required binding fields). A
  // malformed surfaces.yaml fails at load, not silently.
  const surfaces = SurfacesSchema.parse(surfacesRaw);

  // Detach so we never mutate the caller's object (idempotent fold).
  const out = structuredClone(raw);
  delete out.surfaces;

  const agents = out.agents;
  if (!Array.isArray(agents)) {
    throw new Error(
      "config-composer: surfaces.yaml is present but the composed config declares no `agents:` array to fold bindings into — " +
        "surface bindings name an agent id, so at least one stack with `agents:` must compose alongside surfaces.yaml.",
    );
  }

  // Index agents by id for the fold join.
  const agentById = new Map<string, Record<string, unknown>>();
  for (const a of agents) {
    if (isPlainObject(a) && typeof a.id === "string") {
      agentById.set(a.id, a);
    }
  }

  // Indexed generically — `foldPlatforms` is a plain `string[]` (registry-
  // derived by `loader.ts`, or the {@link DEFAULT_FOLD_PLATFORMS} fallback),
  // not the narrow literal union `SurfacesSchema`'s explicit keys infer to.
  const surfacesByKey = surfaces as Record<string, readonly SurfaceBindingEntry[] | undefined>;
  for (const platform of foldPlatforms) {
    const entries = surfacesByKey[platform];
    if (!entries) continue;
    for (const entry of entries) {
      const agent = agentById.get(entry.agent);
      if (!agent) {
        throw new Error(
          `config-composer: surfaces.yaml ${platform} binding names agent "${entry.agent}", ` +
            `but no agents[].id in the composed config matches it. ` +
            `Known agent ids: [${[...agentById.keys()].join(", ") || "(none)"}]. ` +
            `Fix the binding's \`agent:\` field or add the agent to a stack.`,
        );
      }
      const presence = isPlainObject(agent.presence) ? agent.presence : {};
      const existing = isPlainObject(presence[platform])
        ? presence[platform]
        : {};
      // Binding wins on leaf keys (surfaces.yaml is the credential surface of
      // truth, layered over any inline non-binding presence knobs).
      presence[platform] = { ...existing, ...entry.binding };
      agent.presence = presence;
    }
  }

  return out;
}
