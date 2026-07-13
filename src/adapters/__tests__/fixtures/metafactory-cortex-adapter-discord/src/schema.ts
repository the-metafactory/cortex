/**
 * cortex#1797 (S12, ADR-0024 D5 extraction lane) — Discord's binding +
 * presence schemas, relocated/duplicated here so `src/adapters/discord/*.ts`
 * never needs to reach into cortex core for them. Mirrors the S9b/S10/S11
 * precedent (`metafactory-cortex-adapter-{web,slack,mattermost}`'s own
 * `src/schema.ts`).
 *
 * ## `DiscordBindingSchema` — relocated from `common/types/surfaces.ts`
 *
 * S4 (`adapters/registry.ts`'s `AdapterPlugin.bindingSchema` docstring)
 * already establishes the principle: a plugin's binding schema is
 * PLUGIN-OWNED data, not something the config layer should hardcode. Before
 * this slice, `common/types/surfaces.ts` was the schema's home (the LAST
 * hardcoded per-platform binding schema left there — web/slack/mattermost
 * had already moved theirs out at S9/S10/S11) and
 * `src/adapters/discord/plugin.ts` reached `../../common/types/surfaces` to
 * read it back — a cross-boundary import that made the discord adapter
 * directory un-compilable against `surface-sdk` alone. Moving the
 * definition HERE inverts that dependency; `common/types/surfaces.ts`'s
 * `SurfacesSchema` drops its last hardcoded platform key and validates
 * `discord[]` via the generic catchall, same as the other three.
 *
 * ## `DiscordPresenceSchema`/`DiscordPresence` — a plugin-owned DUPLICATE, not a move
 *
 * The canonical `DiscordPresenceSchema`/`DiscordPresence` in
 * `common/types/cortex-config.ts` is deeply embedded in cortex-wide config
 * machinery — `common/types/config.ts` (`AgentConfigSchema.discord`),
 * `common/config/loader.ts`, `common/config/resolve-env-placeholders.ts`,
 * `cli/cortex/commands/migrate-config-lib.ts`, and
 * `runner/surface-adapter-boot.ts` all consume it independently of whether
 * the Discord ADAPTER is in-tree or an external bundle — it is the "fold
 * `surfaces.discord[]`/`agents[].presence.discord` into a validated presence
 * object" schema for the WHOLE config subsystem, not plugin-construction
 * data. Moving it would break config loading; so it STAYS in
 * `cortex-config.ts`.
 *
 * `discordAdapterPlugin.buildGatewayConstructArgs` (the shared surface
 * gateway's shadow-stage construction path, `gateway-adapters.ts`'s
 * `buildGatewayAdapters`) still needs to turn a raw `surfaces.discord[].binding`
 * record into a fully-defaulted `DiscordPresence` shape before constructing
 * `DiscordAdapter` — exactly the job `DiscordPresenceSchema.parse()` did
 * pre-extraction. This module's `DiscordPresenceSchema` is an independent,
 * byte-identical-in-behaviour (same fields, same regexes, same defaults)
 * COPY scoped to that one call site. `DiscordAdapter`'s own
 * `presence: DiscordPresence` constructor parameter is typed against THIS
 * module's `DiscordPresence`, not cortex-config's — the real cortex-config
 * `DiscordPresence` (a structural superset) satisfies it at every real call
 * site, so behaviour is unchanged; only the compile-time type source moved.
 */

import { z } from "zod/v4";

// =============================================================================
// Binding schema — validates `surfaces.discord[].binding`
// =============================================================================

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

// =============================================================================
// Presence schema — plugin-owned copy for `buildGatewayConstructArgs`
// =============================================================================

/**
 * Plugin-owned mirror of `common/types/cortex-config.ts`'s
 * `DiscordPresenceSchema` — see the module doc above for why this is a
 * duplicate, not a relocation. Field-for-field, regex-for-regex identical.
 */
export const DiscordPresenceSchema = z.object({
  /** Whether this presence is active. Default: true. */
  enabled: z.boolean().default(true),
  token: z.string().min(1),
  guildId: z.coerce.string().min(1),
  agentChannelId: z.coerce.string().min(1),
  logChannelId: z.coerce.string().min(1),
  /** Channel id for worklog threads (G-200). If set, agent tasks get threaded updates. */
  worklogChannelId: z.coerce.string().optional(),
  contextDepth: z.number().int().positive().default(10),
  /** Post agent events to #agent-log. Default: false (opt-in). */
  enableAgentLog: z.boolean().default(false),
  /**
   * F-11: Optional Discord role id to mention on `severity = 'ping'`
   * notifications. Unset → plain channel post with no mention.
   */
  operatorRoleId: z.coerce.string().optional(),
  /**
   * cortex#98 (part A) — principal-set Discord user ids of peer bots that
   * are permitted to trigger this presence. Cross-process bridge; the
   * TrustResolver (cortex#76) merges in-process peers separately.
   */
  trustedBotIds: z.array(z.coerce.string()).default([]),
  /**
   * cortex#709 — DM stack-OWNERSHIP flag. Exactly one stack in a
   * multi-stack deployment should set it `true`; see cortex-config.ts's
   * `DiscordPresenceSchema` doc for the full misconfiguration-semantics
   * writeup this mirrors.
   */
  dmOwner: z.boolean().default(true),
  /** MIG-3b / cortex#205: NATS subject patterns this Discord adapter renders to chat. */
  surfaceSubjects: z.array(z.string().min(1)).default([]),
  /** MIG-3b / cortex#207: fallback Discord channel id for envelope rendering. */
  surfaceFallbackChannelId: z.coerce.string().optional(),
});

export type DiscordPresence = z.infer<typeof DiscordPresenceSchema>;
