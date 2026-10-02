/**
 * cortex#2524 — the ONE `InboundMessage → GateReplyOffer` mapping shared by
 * the per-stack inbound path and the surface gateway's interceptor.
 */

import { describe, expect, test } from "bun:test";
import { gateRoutingThread, toGateReplyOffer } from "../gate-reply-offer";
import type { InboundMessage } from "../types";

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "web",
    instanceId: "web:console",
    authorId: "principal-1",
    authorName: "Principal",
    content: "yes",
    channelId: "ch-1",
    attachments: [],
    timestamp: new Date(0),
    ...over,
  };
}

describe("gateRoutingThread / toGateReplyOffer", () => {
  test("an unthreaded message keys on the channel id", () => {
    expect(gateRoutingThread(inbound())).toBe("ch-1");
    expect(gateRoutingThread(inbound({ threadId: "" }))).toBe("ch-1");
  });

  test("a threaded message keys on the thread id", () => {
    expect(gateRoutingThread(inbound({ threadId: "t-9" }))).toBe("t-9");
  });

  test("maps every offer field from the message", () => {
    expect(toGateReplyOffer(inbound({ threadId: "t-9" }))).toEqual({
      surface: "web",
      channel: "ch-1",
      thread: "t-9",
      authorId: "principal-1",
      text: "yes",
    });
  });
});
