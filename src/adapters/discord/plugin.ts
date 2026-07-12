/**
 * cortex#1788 (S3, ADR-0024 D5) — Discord `AdapterPlugin`.
 *
 * Carries discord's platform id, its binding→demux-key rule, its
 * token-grouping rule (design-pluggable-adapters.md §3.4 — "no discord
 * special-case survives in the generic loop"; it lives HERE instead of in
 * `buildGatewayAdapters`), the field that must clear the cortex#1209
 * unresolved-placeholder guard, and the construction function itself.
 * `createAdapter`'s body is `defaultGatewayAdapterFactory.discord`'s
 * pre-registry body (`src/gateway/gateway-adapters.ts`, GW.a.3b.2b /
 * S9-cortex#1523), relocated verbatim — behavior is UNCHANGED, only the home
 * moved. `gateway-adapters.ts` keeps a thin back-compat
 * `defaultGatewayAdapterFactory` shim delegating here.
 */

import { DiscordAdapter } from "./index";
import {
  DiscordPresenceSchema,
  type DiscordPresence,
  type Agent,
} from "../../common/types/cortex-config";
import { DiscordBindingSchema } from "../../common/types/surfaces";
import type { SystemEventSource } from "../../bus/system-events";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { PolicyEngine, PlatformPrincipalIndex, PrincipalRegistry } from "../../common/policy";
import type {
  AdapterPlugin,
  BindingGroup,
  GatewayConstructBase,
} from "../registry";
import { resolveFactoryAgent, stringBindingField } from "../plugin-support";
import { groupDiscordBindingsByToken } from "../../gateway/discord-token-groups";

/**
 * Construction args `createAdapter` accepts — the same shape
 * `defaultGatewayAdapterFactory.discord` accepted pre-registry
 * (`DiscordFactoryArgs`, `src/gateway/gateway-adapters.ts`), redeclared here
 * so this module has no compile-time dependency on `gateway-adapters.ts`.
 */
interface DiscordCreateArgs {
  instanceId: string;
  source: SystemEventSource | undefined;
  presence: DiscordPresence;
  runtime: MyelinRuntime | undefined;
  allowedGuildIds: ReadonlySet<string>;
  presenceByGuildId: ReadonlyMap<string, DiscordPresence>;
  agent?: Agent;
  principal?: Record<string, unknown>;
  policyEngine?: PolicyEngine;
  policyLookup?: PlatformPrincipalIndex;
  policyRegistry?: PrincipalRegistry;
  trustedBotIds?: ReadonlySet<string>;
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
}

export const discordAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "discord",
  platform: "discord",
  // cortex#1789 (S4) — `DiscordBindingSchema`, NOT `DiscordPresenceSchema`:
  // this is the EXACT schema `surfaces.discord[].binding` validated pre-S4
  // (`DiscordSurfaceBindingSchema` in `common/types/surfaces.ts`), so the
  // registry pass is byte-identical to the old `.strict()`-object validation.
  // `DiscordPresenceSchema` (the fuller presence shape) stays in use below,
  // in `buildGatewayConstructArgs`, for the separate gateway-path parse.
  bindingSchema: DiscordBindingSchema,
  // Discord/Slack/Mattermost fold into `agents[*].presence.{platform}` at
  // config-compose time (legacy inline-presence shape exists to fold into).
  foldsIntoPresence: true,
  secretFields: ["token"],
  // Used only as the ungrouped-fallback demux key; `groupBindings` below
  // always runs for discord, so this is a spec-completeness fallback, not a
  // live code path today.
  demuxKey: (binding) => stringBindingField(binding, "guildId"),
  // Discord delivers every guild event for a bot token over ONE gateway
  // session — bindings are token-keyed, not guild-keyed
  // (`gateway-adapters.ts` GW.a.3b.2b module doc). This is the only in-tree
  // adapter with non-default grouping.
  groupBindings: (entries) =>
    groupDiscordBindingsByToken(
      entries as unknown as Parameters<typeof groupDiscordBindingsByToken>[0],
    ),
  buildGatewayConstructArgs: (group: BindingGroup, base: GatewayConstructBase) => {
    const presences = group.entries.map((entry) => DiscordPresenceSchema.parse(entry.binding));
    const presenceByGuildId = new Map(presences.map((p) => [p.guildId, p] as const));
    const allowedGuildIds = new Set(presenceByGuildId.keys());
    return {
      instanceId: base.instanceId,
      source: base.source,
      // The FIRST entry's binding — matches the pre-registry loop's
      // `binding: firstBinding` (forwarded for observability/test
      // assertions only; `presence` below is what construction consumes).
      binding: group.entries[0]?.binding,
      runtime: base.runtime,
      presence: presences[0],
      allowedGuildIds,
      presenceByGuildId,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as DiscordCreateArgs;
    const {
      instanceId, source, presence, runtime, allowedGuildIds, presenceByGuildId,
      principal, policyEngine, policyLookup, policyRegistry,
      trustedBotIds, surfaceSubjects, surfaceFallbackChannelId,
    } = a;
    return new DiscordAdapter(
      resolveFactoryAgent(a, { discord: presence }),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        ...(runtime !== undefined && { runtime }),
        ...(source !== undefined && { systemEventSource: source }),
        allowedGuildIds,
        presenceByGuildId,
        ...(trustedBotIds !== undefined && { trustedBotIds }),
        ...(policyEngine !== undefined && { policyEngine }),
        ...(policyLookup !== undefined && { policyLookup }),
        ...(policyRegistry !== undefined && { policyRegistry }),
        ...(surfaceSubjects !== undefined && { surfaceSubjects }),
        ...(surfaceFallbackChannelId !== undefined && { surfaceFallbackChannelId }),
      },
    );
  },
};
