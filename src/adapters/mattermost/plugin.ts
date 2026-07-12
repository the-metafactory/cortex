/**
 * cortex#1788 (S3, ADR-0024 D5) — Mattermost `AdapterPlugin`.
 *
 * `createAdapter`'s body is `defaultGatewayAdapterFactory.mattermost`'s
 * pre-registry body (`src/gateway/gateway-adapters.ts`), relocated verbatim
 * — behavior is UNCHANGED, only the home moved. Mattermost has no grouping
 * (one adapter per binding, demuxed by apiUrl, single-binding fallback).
 */

import { MattermostAdapter } from "./index";
import {
  MattermostPresenceSchema,
  type MattermostPresence,
  type Agent,
} from "../../common/types/cortex-config";
import { MattermostBindingSchema } from "../../common/types/surfaces";
import type { SystemEventSource } from "../../bus/system-events";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { PolicyEngine, PlatformPrincipalIndex, PrincipalRegistry } from "../../common/policy";
import type { AdapterPlugin } from "../registry";
import { resolveFactoryAgent, stringBindingField } from "../plugin-support";

/** Construction args `createAdapter` accepts — the same shape
 *  `defaultGatewayAdapterFactory.mattermost` accepted pre-registry
 *  (`MattermostFactoryArgs`, `src/gateway/gateway-adapters.ts`). */
interface MattermostCreateArgs {
  instanceId: string;
  source: SystemEventSource | undefined;
  presence: MattermostPresence;
  runtime: MyelinRuntime | undefined;
  agent?: Agent;
  principal?: Record<string, unknown>;
  policyEngine?: PolicyEngine;
  policyLookup?: PlatformPrincipalIndex;
  policyRegistry?: PrincipalRegistry;
}

export const mattermostAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "mattermost",
  platform: "mattermost",
  // cortex#1789 (S4) — `MattermostBindingSchema`, the exact schema
  // `surfaces.mattermost[].binding` validated pre-S4 (see discord/plugin.ts's
  // comment for the full rationale). `MattermostPresenceSchema` stays in use
  // below, in `buildGatewayConstructArgs`, for the gateway-path parse.
  bindingSchema: MattermostBindingSchema,
  foldsIntoPresence: true,
  secretFields: ["apiToken"],
  // apiUrl is optional on the presence schema but required on the binding
  // schema; the binding-resolver keys the interim instance on it too.
  demuxKey: (binding) => stringBindingField(binding, "apiUrl", "<unset>"),
  // No groupBindings — one adapter per binding.
  buildGatewayConstructArgs: (group, base) => {
    const firstEntry = group.entries[0];
    const presence = MattermostPresenceSchema.parse(firstEntry?.binding ?? {});
    return {
      instanceId: base.instanceId,
      source: base.source,
      binding: firstEntry?.binding,
      runtime: base.runtime,
      presence,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as MattermostCreateArgs;
    const { instanceId, source, presence, runtime, principal, policyEngine, policyLookup, policyRegistry } = a;
    return new MattermostAdapter(
      resolveFactoryAgent(a, { mattermost: presence }),
      presence,
      {
        instanceId,
        principal: principal ?? {},
        ...(runtime !== undefined && { runtime }),
        ...(source !== undefined && { systemEventSource: source }),
        ...(policyEngine !== undefined && { policyEngine }),
        ...(policyLookup !== undefined && { policyLookup }),
        ...(policyRegistry !== undefined && { policyRegistry }),
      },
    );
  },
};
