/**
 * cortex#1788 (S3, ADR-0024 D5) — Web/SSE `AdapterPlugin`.
 *
 * `createAdapter`'s body is `defaultGatewayAdapterFactory.web`'s pre-registry
 * body (`src/gateway/gateway-adapters.ts`, C-110), relocated verbatim —
 * behavior is UNCHANGED, only the home moved. No binding secrets (auth is CF
 * Access at the edge, not a bot token — `secretFields` is empty) and no
 * presence re-parse (the `WebBinding` already carries every field the
 * adapter needs, unlike Discord/Slack/Mattermost's presence schemas).
 */

import { WebAdapter } from "./index";
import type { WebBinding } from "../../common/types/surfaces";
import type { Agent } from "../../common/types/cortex-config";
import type { SystemEventSource } from "../../bus/system-events";
import type { AdapterPlugin } from "../registry";
import { resolveFactoryAgent, stringBindingField } from "../plugin-support";

/** Construction args `createAdapter` accepts — the same shape
 *  `defaultGatewayAdapterFactory.web` accepted pre-registry
 *  (`WebFactoryArgs`, `src/gateway/gateway-adapters.ts`). `source` is used
 *  only by {@link resolveFactoryAgent}'s synthetic-agent fallback — like the
 *  pre-registry factory, it is never forwarded into `WebAdapterInfra`. */
interface WebCreateArgs {
  instanceId: string;
  webBinding: WebBinding;
  source: SystemEventSource | undefined;
  agent?: Agent;
}

export const webAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "web",
  platform: "web",
  bindingSchema: undefined,
  // No secrets in a web binding — auth is CF Access at the edge, not a bot
  // token (`broadcastUrl` is a non-secret endpoint).
  secretFields: [],
  demuxKey: (binding) => stringBindingField(binding, "instanceId"),
  // No groupBindings — one adapter per binding, demuxed on the configured
  // tenant instanceId.
  buildGatewayConstructArgs: (group, base) => {
    const firstEntry = group.entries[0];
    const webBinding = (firstEntry?.binding ?? {}) as unknown as WebBinding;
    return {
      instanceId: base.instanceId,
      binding: firstEntry?.binding,
      webBinding,
      source: base.source,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as WebCreateArgs;
    return new WebAdapter(
      resolveFactoryAgent(a, {}),
      a.webBinding,
      {
        instanceId: a.instanceId,
        principal: {},
      },
    );
  },
};
