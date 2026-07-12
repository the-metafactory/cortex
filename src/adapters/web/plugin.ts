/**
 * cortex#1788 (S3, ADR-0024 D5) — Web/SSE `AdapterPlugin`.
 * cortex#1794 (S9b) — dependency-inversion pass: this file (and
 * `src/adapters/web/index.ts`) now imports ONLY from `../../surface-sdk`
 * across the `src/adapters/web/` boundary (plus intra-directory `./index` /
 * `./schema`) — no `common/policy`, no `common/types/surfaces`, no
 * `common/types/cortex-config`, no `bus/system-events`. The binding schema
 * moved to `./schema` (plugin-owned data, S4's own principle); the agent
 * identity narrowed to {@link AdapterAgentIdentity} (the only field
 * `WebAdapter` reads); the policy-resolution calls became a host-injected
 * `AdapterPolicyPort` (see `../../surface-sdk`) built by
 * `../plugin-support`'s `buildAdapterPolicyPort` — cortex-side code the
 * host (`gateway-adapters.ts`) calls, never this file. This makes
 * `src/adapters/web/` compilable in isolation against `surface-sdk` alone —
 * the precondition the S10+ MOVE slice needs to actually relocate it out of
 * this repo. `createAdapter`'s body is still, structurally,
 * `defaultGatewayAdapterFactory.web`'s pre-registry body (C-110) — this
 * slice inverted WHERE its dependencies come from, not WHAT it constructs;
 * behavior is unchanged (see `docs/plugin-sdk.md` / cortex#1794 for the
 * audit).
 */

import { WebAdapter, type AdapterAgentIdentity } from "./index";
import { WebBindingSchema, type WebBinding } from "./schema";
import type { AdapterPlugin, AdapterPolicyPort } from "../../surface-sdk";
import { stringBindingField, buildAdapterPolicyPort } from "../plugin-support";

/**
 * Construction args `createAdapter` accepts — the same shape
 * `defaultGatewayAdapterFactory.web` accepted pre-registry (`WebFactoryArgs`,
 * `src/gateway/gateway-adapters.ts`), minus the `Agent`/`SystemEventSource`
 * cortex-internal types (cortex#1794 S9b — see module doc). `source` is used
 * only by {@link resolveWebAgent}'s synthetic-identity fallback — like the
 * pre-registry factory, it is never forwarded into `WebAdapterInfra`.
 * `policy` is the host-bound {@link AdapterPolicyPort} — forwarded from
 * `GatewayConstructBase.policy` (only caller today: `buildGatewayAdapters`).
 */
interface WebCreateArgs {
  instanceId: string;
  webBinding: WebBinding;
  source: { agent: string } | undefined;
  agent?: AdapterAgentIdentity;
  policy?: AdapterPolicyPort;
}

/**
 * cortex#1794 (S9b) — the web-local, `Agent`-free replacement for
 * `plugin-support.ts`'s `resolveFactoryAgent` (which returns a full cortex
 * `Agent` — persona/trust/presence — that `WebAdapter` never reads past
 * `.id`). Same fallback order and the SAME thrown error message as
 * `resolveFactoryAgent`: `args.agent` wins; else derive `{id: source.agent}`
 * from the gateway source identity; else throw (a caller must supply one or
 * the other).
 */
function resolveWebAgent(args: {
  agent?: AdapterAgentIdentity;
  source: { agent: string } | undefined;
}): AdapterAgentIdentity {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return { id: args.source.agent };
}

export const webAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "web",
  platform: "web",
  // cortex#1789 (S4) — the exact schema `surfaces.web[].binding` validated
  // pre-S4 (`WebSurfaceBindingSchema` in `common/types/surfaces.ts`).
  // cortex#1794 (S9b) — now defined in `./schema` (plugin-owned).
  bindingSchema: WebBindingSchema,
  // Unlike discord/slack/mattermost, web has no legacy inline-presence shape
  // to fold into — the gateway factory consumes `surfaces.web[]` directly
  // (see `WebSurfaceBindingSchema`'s docstring). PRESERVE: web does NOT fold.
  foldsIntoPresence: false,
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
      // cortex#1794 (S9b) — forward the host-bound port straight through.
      // `base.policy` is `unknown` at the registry layer (see
      // `GatewayConstructBase`'s doc) and this function's own return type is
      // `Record<string, unknown>`, so no cast is needed here — `createAdapter`
      // below is where it's narrowed back to `AdapterPolicyPort`.
      policy: base.policy,
    };
  },
  createAdapter: (args) => {
    const a = args as unknown as WebCreateArgs;
    return new WebAdapter(
      resolveWebAgent(a),
      a.webBinding,
      {
        instanceId: a.instanceId,
        principal: {},
        // cortex#1794 (S9b) — `WebAdapterInfra.policy` is REQUIRED; default
        // to the "no policy configured" port (deny-by-default — see
        // `buildAdapterPolicyPort`'s doc) when no host port was supplied,
        // e.g. a caller that builds `WebCreateArgs` by hand without going
        // through `buildGatewayConstructArgs`.
        policy: a.policy ?? buildAdapterPolicyPort(),
      },
    );
  },
};
