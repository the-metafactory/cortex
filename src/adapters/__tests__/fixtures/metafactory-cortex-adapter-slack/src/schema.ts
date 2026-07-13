/**
 * cortex#1795 (S10, ADR-0024 D5 extraction lane) — the Slack surface's
 * binding + presence schemas, relocated/duplicated here so
 * `src/adapters/slack/*.ts` never needs to reach into cortex core for them.
 *
 * ## `SlackBindingSchema` — relocated from `common/types/surfaces.ts`
 *
 * S4 (`adapters/registry.ts`'s `AdapterPlugin.bindingSchema` docstring, and
 * cortex#1794 S9b's identical move for `WebBindingSchema`) already
 * establishes the principle: a plugin's binding schema is PLUGIN-OWNED data,
 * not something the config layer should hardcode. Before this slice,
 * `common/types/surfaces.ts` was the schema's home and
 * `src/adapters/slack/plugin.ts` reached `../../common/types/surfaces` to
 * read it back — a cross-boundary import that made the slack adapter
 * directory un-compilable against `surface-sdk` alone. Moving the
 * definition HERE inverts that dependency.
 *
 * ## `SlackPresenceSchema`/`SlackPresence` — a plugin-owned DUPLICATE, not a move
 *
 * Unlike `WebBindingSchema` (which had exactly one other consumer,
 * `surfaces.ts`), the canonical `SlackPresenceSchema`/`SlackPresence` in
 * `common/types/cortex-config.ts` is deeply embedded in cortex-wide config
 * machinery — `common/types/config.ts` (`AgentConfigSchema.slack`),
 * `common/config/loader.ts`, `common/config/resolve-env-placeholders.ts`,
 * `cli/cortex/commands/migrate-config-lib.ts`, and
 * `runner/surface-adapter-boot.ts` all consume it independently of whether
 * the Slack ADAPTER is in-tree or an external bundle — it is the "fold
 * `surfaces.slack[]`/`agents[].presence.slack` into a validated presence
 * object" schema for the WHOLE config subsystem, not plugin-construction
 * data. Moving it would break config loading; so it STAYS in
 * `cortex-config.ts`.
 *
 * `slackAdapterPlugin.buildGatewayConstructArgs` (the shared surface
 * gateway's shadow-stage construction path, `gateway-adapters.ts`'s
 * `buildGatewayAdapters`) still needs to turn a raw `surfaces.slack[].binding`
 * record into a fully-defaulted `SlackPresence` shape before constructing
 * `SlackAdapter` — exactly the job `SlackPresenceSchema.parse()` did
 * pre-extraction. This module's `SlackPresenceSchema` is an independent,
 * byte-identical-in-behaviour (same fields, same regexes, same defaults)
 * COPY scoped to that one call site. It duplicates ~15 lines already
 * duplicated once (the pre-existing `SlackBindingSchema` in `surfaces.ts`
 * was already a lighter subset of the same fields) — an accepted,
 * documented residual rather than a second cross-boundary import.
 * `SlackAdapter`'s own `presence: SlackPresence` constructor parameter is
 * typed against THIS module's `SlackPresence`, not cortex-config's — the
 * real cortex-config `SlackPresence` (a structural superset) satisfies it at
 * every real call site, so behaviour is unchanged; only the compile-time
 * type source moved.
 */

import { z } from "zod/v4";

// =============================================================================
// Binding schema — validates `surfaces.slack[].binding`
// =============================================================================

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

// =============================================================================
// Presence schema — plugin-owned copy for `buildGatewayConstructArgs`
// =============================================================================

/**
 * Plugin-owned mirror of `common/types/cortex-config.ts`'s
 * `SlackPresenceSchema` — see the module doc above for why this is a
 * duplicate, not a relocation. Field-for-field, regex-for-regex identical.
 */
export const SlackPresenceSchema = z.object({
  enabled: z.boolean().default(true),
  botToken: z.string().regex(
    /^xoxb-/,
    "slack.botToken must be a bot user OAuth token (xoxb-...)",
  ),
  appToken: z.string().regex(
    /^xapp-/,
    "slack.appToken must be an app-level token (xapp-...)",
  ),
  workspaceId: z.coerce.string().regex(
    /^T[A-Z0-9]{8,16}$/,
    "slack.workspaceId must be a Slack team id (T... with 8-16 trailing chars)",
  ),
  channels: z.array(z.object({
    id: z.string().regex(
      /^[CG][A-Z0-9]{8,16}$/,
      "slack channel id must be a Slack channel/group id (C... or G... with 8-16 trailing chars)",
    ),
    name: z.string().min(1),
  })).default([]),
  allowedUserIds: z.array(z.string()).default([]),
  trustedBotIds: z.array(z.coerce.string()).default([]),
  surfaceSubjects: z.array(z.string().min(1)).default([]),
  surfaceFallbackChannelId: z.coerce.string().optional(),
});

export type SlackPresence = z.infer<typeof SlackPresenceSchema>;
