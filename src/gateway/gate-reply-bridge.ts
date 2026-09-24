/**
 * `gate-reply-bridge.ts` — the shared surface gateway's side of the adapter
 * inbound reply-bridge (Bot Packs B-3, cortex#1021 W-1; cortex#2524).
 *
 * The gateway offers each inbound message to the gate router of the runtime
 * that started it, through `SurfaceGateway`'s pre-route interceptor. The
 * message → offer mapping itself is the surface-neutral
 * `adapters/gate-reply-offer.ts`, shared with the per-stack inbound path.
 *
 * ## In-process only (cortex#2526)
 *
 * The interceptor is a synchronous in-process call, so it reaches only the
 * gates of the runtime that hosts the gateway. A stack whose daemon does not
 * host the gateway gets no reply bridge on gateway-owned surfaces: the reply
 * routes on as chat and the gate times out to `fail`. A gateway split out
 * into its own process (CONTEXT.md §Dispatch source) needs the bus-carried
 * reply path tracked in cortex#2526.
 *
 * ## An open gate holds its whole channel on unthreaded surfaces
 *
 * The router's modal-thread rule (`bus/gate-reply-router.ts`) consumes every
 * message on an open gate's key, principal or not; the gate ignores the
 * others. An unthreaded message keys on its channel id, so on `web`, where a
 * binding's traffic is one channel, an open gate takes every message on that
 * channel as a gate reply until it resolves or times out — none of them
 * becomes a chat dispatch in that window.
 */

import { toGateReplyOffer } from "../adapters/gate-reply-offer";
import type { GateReplyRouter } from "../bus/gate-reply-router";
import type { GatewayBindingMatch } from "./binding-resolver";
import type { InboundInterceptor } from "./surface-gateway";

/** The `{principal}/{stack}` the owning runtime's chat listeners subscribe under. */
export interface GateOwnerStack {
  principal: string;
  stack: string;
}

/**
 * Whether a gateway binding routes to the runtime's own stack: its parsed
 * `{principal}/{stack}` equals the one the runtime's chat listeners subscribe
 * under. A binding with no `stack` field (gap 4) publishes on the stackless
 * `local.{principal}.tasks.…` subject, while a runtime's chat listeners
 * always subscribe under `local.{principal}.{stack}.tasks.*.>`
 * (`runner/dispatch-listener.ts`, `stack` = the boot-derived stack). So a
 * stackless binding is never own, and a gate reply on it fails closed (the
 * gate times out). Bind the surface with `stack:` to gate on it.
 */
export function isOwnStackBinding(match: GatewayBindingMatch, own: GateOwnerStack): boolean {
  return match.principal === own.principal && match.stack === own.stack;
}

/**
 * The gateway pre-route interceptor for one runtime: offer each inbound
 * message to that runtime's gate reply-bridge, unless its binding routes to
 * another stack (never offered — it routes on untouched). An unroutable
 * message (`match === null`) names no stack and is still offered: it may be
 * a reply in a thread that has an open gate.
 */
export function createGateReplyInterceptor(opts: {
  router: Pick<GateReplyRouter, "offer">;
  own: GateOwnerStack;
}): InboundInterceptor {
  return (msg, match) =>
    (match === null || isOwnStackBinding(match, opts.own)) &&
    opts.router.offer(toGateReplyOffer(msg));
}
