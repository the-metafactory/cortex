/**
 * cortex#1788 (S3, ADR-0024 D5) — Slack `AdapterPlugin`.
 *
 * `createAdapter`'s body is `defaultGatewayAdapterFactory.slack`'s
 * pre-registry body (`src/gateway/gateway-adapters.ts`), relocated verbatim
 * — behavior is UNCHANGED, only the home moved. Slack has no grouping (one
 * adapter per binding, demuxed by workspace id) — `groupBindings` is absent.
 */

import { SlackAdapter } from "./index";
import {
  SlackPresenceSchema,
  type SlackPresence,
  type Agent,
} from "../../common/types/cortex-config";
import { SlackBindingSchema } from "../../common/types/surfaces";
import type { SystemEventSource } from "../../bus/system-events";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { PolicyEngine, PlatformPrincipalIndex, PrincipalRegistry } from "../../common/policy";
import type { AdapterPlugin } from "../../surface-sdk";
import { resolveFactoryAgent, stringBindingField } from "../plugin-support";

/** Construction args `createAdapter` accepts — the same shape
 *  `defaultGatewayAdapterFactory.slack` accepted pre-registry
 *  (`SlackFactoryArgs`, `src/gateway/gateway-adapters.ts`). */
interface SlackCreateArgs {
  instanceId: string;
  source: SystemEventSource | undefined;
  presence: SlackPresence;
  runtime: MyelinRuntime | undefined;
  agent?: Agent;
  principal?: Record<string, unknown>;
  policyEngine?: PolicyEngine;
  policyLookup?: PlatformPrincipalIndex;
  policyRegistry?: PrincipalRegistry;
  trustedBotIds?: ReadonlySet<string>;
  surfaceSubjects?: string[];
  surfaceFallbackChannelId?: string;
}

export const slackAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "slack",
  platform: "slack",
  // cortex#1789 (S4) — `SlackBindingSchema`, the exact schema
  // `surfaces.slack[].binding` validated pre-S4 (see discord/plugin.ts's
  // comment for the full rationale). `SlackPresenceSchema` stays in use
  // below, in `buildGatewayConstructArgs`, for the gateway-path parse.
  bindingSchema: SlackBindingSchema,
  foldsIntoPresence: true,
  secretFields: ["botToken", "appToken"],
  demuxKey: (binding) => stringBindingField(binding, "workspaceId"),
  // No groupBindings — one adapter per binding, demuxed on workspaceId.
  buildGatewayConstructArgs: (group, base) => {
    const firstEntry = group.entries[0];
    const presence = SlackPresenceSchema.parse(firstEntry?.binding ?? {});
    return {
      instanceId: base.instanceId,
      source: base.source,
      binding: firstEntry?.binding,
      runtime: base.runtime,
      presence,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as SlackCreateArgs;
    const {
      instanceId, source, presence, runtime,
      principal, policyEngine, policyLookup, policyRegistry,
      trustedBotIds, surfaceSubjects, surfaceFallbackChannelId,
    } = a;
    return new SlackAdapter(
      resolveFactoryAgent(a, { slack: presence }),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        ...(runtime !== undefined && { runtime }),
        ...(source !== undefined && { systemEventSource: source }),
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
