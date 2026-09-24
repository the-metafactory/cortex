/**
 * `gate-reply-bridge.ts` — the surface-side half of the adapter inbound
 * reply-bridge (Bot Packs B-3, cortex#1021 W-1; cortex#2524).
 *
 * `GateReplyRouter` (bus layer) is deliberately blind to adapter DTOs (sage
 * #1037 round 2), so the surface layer owns the `InboundMessage →
 * GateReplyOffer` mapping — and this module is its ONE home. Both inbound
 * paths use it: the per-stack handler in `cortex.ts` (folded presences) and
 * the shared surface gateway's pre-route interceptor (gateway-owned surfaces;
 * the web adapter's only path). One mapping, so the two paths cannot drift on
 * the routing key.
 */

import type { InboundMessage } from "../adapters/types";
import type { GateReplyOffer, GateReplyRouter } from "../bus/gate-reply-router";
import type { GatewayBindingMatch } from "./binding-resolver";
import type { InboundInterceptor } from "./surface-gateway";

/**
 * The routing key for both the gate reply-bridge and a brain task's
 * `response_routing`. A top-level (non-threaded) surface message has no
 * native thread, so the channel id is the key — used IDENTICALLY on the
 * gate-await side and the offer side, so a gate prompt and the principal's
 * reply correlate whether the conversation is threaded or not.
 */
export function gateRoutingThread(msg: InboundMessage): string {
  return msg.threadId !== undefined && msg.threadId.length > 0 ? msg.threadId : msg.channelId;
}

/** Map a normalized inbound message onto the bus-neutral gate reply offer. */
export function toGateReplyOffer(msg: InboundMessage): GateReplyOffer {
  return {
    surface: msg.platform,
    channel: msg.channelId,
    thread: gateRoutingThread(msg),
    authorId: msg.authorId,
    text: msg.content,
  };
}

/** The `{principal}/{stack}` identity of the runtime that owns a gate router. */
export interface GateOwnerStack {
  principal: string;
  stack: string;
}

/**
 * Whether a gateway binding belongs to the runtime's own stack. One gateway
 * may serve several bound stacks, but a runtime's gates only ever await
 * replies on its own stack's bindings. A binding with no `stack` field
 * (gap 4) publishes on the gateway principal's own namespace, so it counts
 * as own.
 */
export function isOwnStackBinding(match: GatewayBindingMatch, own: GateOwnerStack): boolean {
  if (match.stack === undefined) return true;
  return match.principal === own.principal && match.stack === own.stack;
}

/**
 * The gateway pre-route interceptor for one runtime: offer each inbound
 * message to that runtime's gate reply-bridge, unless its binding belongs to
 * another stack (never offered — it routes on to its own stack untouched).
 * An unroutable message (`match === null`) names no stack and is still
 * offered: it may be a reply in a thread that has an open gate.
 */
export function createGateReplyInterceptor(opts: {
  router: Pick<GateReplyRouter, "offer">;
  own: GateOwnerStack;
}): InboundInterceptor {
  return (msg, match) =>
    (match === null || isOwnStackBinding(match, opts.own)) &&
    opts.router.offer(toGateReplyOffer(msg));
}
