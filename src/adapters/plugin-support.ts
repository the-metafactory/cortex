/**
 * cortex#1788 (S3) — shared helpers every in-tree `AdapterPlugin.createAdapter`
 * body needs. Moved verbatim out of `src/gateway/gateway-adapters.ts`'s
 * `defaultGatewayAdapterFactory` closures (GW.a.3b.2b, S9/cortex#1523) so the
 * four platform plugin modules (`discord/plugin.ts`, `slack/plugin.ts`,
 * `mattermost/plugin.ts`, `web/plugin.ts`) can share them without each
 * reaching into `gateway-adapters.ts` for gateway-only construction logic.
 * Behavior is UNCHANGED — this is a relocation, not a rewrite.
 */

import type { Agent } from "../common/types/cortex-config";
import type { SystemEventSource } from "../bus/system-events";

/**
 * The gateway owns one connection per binding but is NOT a stack — it has no
 * persona file and dispatches nothing locally (inbound is rebound to the
 * gateway's sink, bypassing `dispatchHandler.handleMessage`). The adapter
 * constructor still requires an `Agent`; build a minimal synthetic one keyed
 * to the binding's `agent` id so log lines and the trust set are coherent.
 *
 * `persona` is a sentinel — the gateway never spawns a CC session through this
 * adapter, so the persona file is never read.
 */
export function syntheticGatewayAgent(
  agentId: string,
  presence: Agent["presence"],
): Agent {
  return {
    id: agentId,
    displayName: agentId,
    persona: "(gateway-owned — no local dispatch)",
    trust: [],
    presence,
  };
}

/**
 * S9 (cortex#1523) — resolve the `Agent` a factory call constructs the
 * adapter with. `args.agent` (the per-stack boot path always supplies it)
 * wins; the gateway never supplies `agent`, so it falls through to the
 * synthetic gateway-owned placeholder keyed off `args.source`. Throws if
 * NEITHER is present — a caller must supply one or the other so the
 * constructed adapter always has a real identity.
 */
export function resolveFactoryAgent(
  args: { agent?: Agent; source: SystemEventSource | undefined },
  presence: Agent["presence"],
): Agent {
  if (args.agent) return args.agent;
  if (!args.source) {
    throw new Error(
      "AdapterPlugin.createAdapter: constructing an adapter requires either `agent` or `source` (neither was supplied)",
    );
  }
  return syntheticGatewayAgent(args.source.agent, presence);
}

/**
 * Safely read a string-typed field off a raw `Record<string, unknown>`
 * binding for `AdapterPlugin.demuxKey`'s ungrouped fallback. Bare
 * `String(binding.x ?? "")` trips `@typescript-eslint/no-base-to-string`
 * because `binding.x` is `unknown` and could stringify to
 * `"[object Object]"` for a non-string value; a demux key built from that
 * would silently misgroup bindings instead of failing loudly.
 */
export function stringBindingField(binding: Record<string, unknown>, field: string, fallback = ""): string {
  const value = binding[field];
  return typeof value === "string" ? value : fallback;
}
