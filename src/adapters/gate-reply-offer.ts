/**
 * `gate-reply-offer.ts` — the ONE `InboundMessage → GateReplyOffer` mapping
 * for the adapter inbound reply-bridge (Bot Packs B-3, cortex#1021 W-1;
 * cortex#2524).
 *
 * `GateReplyRouter` (bus layer) is deliberately blind to adapter DTOs (sage
 * #1037 round 2), so the surface layer owns this mapping. Both inbound paths
 * use it — the per-stack handler in `cortex.ts` (folded presences) and the
 * shared surface gateway's interceptor (`gateway/gate-reply-bridge.ts`) — so
 * the two cannot drift on the routing key.
 */

import type { InboundMessage } from "./types";
import type { GateReplyOffer } from "../bus/gate-reply-router";

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
