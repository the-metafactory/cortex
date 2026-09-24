/**
 * cortex#2524 — the gateway's gate reply-bridge: the own-stack filter the
 * interceptor applies before offering a message to a runtime's gates. (The
 * message → offer mapping is tested with `adapters/gate-reply-offer.ts`.)
 */

import { describe, expect, test } from "bun:test";
import { createGateReplyInterceptor, isOwnStackBinding } from "../gate-reply-bridge";
import { toGateReplyOffer } from "../../adapters/gate-reply-offer";
import type { GatewayBindingMatch } from "../binding-resolver";
import type { GateReplyOffer } from "../../bus/gate-reply-router";
import type { InboundMessage } from "../../adapters/types";

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

function match(over: Partial<GatewayBindingMatch> = {}): GatewayBindingMatch {
  return { platform: "web", agent: "arve", principal: "jc", stack: "switch", instance: "web:console", ...over };
}

const OWN = { principal: "jc", stack: "switch" };

describe("isOwnStackBinding", () => {
  test("same principal and stack → own", () => {
    expect(isOwnStackBinding(match(), OWN)).toBe(true);
  });

  test("another stack of the same principal → not own", () => {
    expect(isOwnStackBinding(match({ stack: "default" }), OWN)).toBe(false);
  });

  test("the same stack leaf under another principal → not own", () => {
    expect(isOwnStackBinding(match({ principal: "andreas" }), OWN)).toBe(false);
  });

  test("a stackless (gap-4) binding publishes on the stackless subject no runtime listens on → not own", () => {
    expect(isOwnStackBinding(match({ principal: undefined, stack: undefined }), OWN)).toBe(false);
  });
});

describe("createGateReplyInterceptor", () => {
  function recordingRouter(consume: boolean) {
    const offers: GateReplyOffer[] = [];
    return {
      offers,
      router: {
        offer: (o: GateReplyOffer) => {
          offers.push(o);
          return consume;
        },
      },
    };
  }

  test("offers an own-stack message and returns the router's verdict", () => {
    const { offers, router } = recordingRouter(true);
    const intercept = createGateReplyInterceptor({ router, own: OWN });
    expect(intercept(inbound(), match())).toBe(true);
    expect(offers).toEqual([toGateReplyOffer(inbound())]);
  });

  test("never offers a message bound to another stack", () => {
    const { offers, router } = recordingRouter(true);
    const intercept = createGateReplyInterceptor({ router, own: OWN });
    expect(intercept(inbound(), match({ stack: "default" }))).toBe(false);
    expect(offers).toHaveLength(0);
  });

  test("offers an unroutable message (null match)", () => {
    const { offers, router } = recordingRouter(false);
    const intercept = createGateReplyInterceptor({ router, own: OWN });
    expect(intercept(inbound(), null)).toBe(false);
    expect(offers).toHaveLength(1);
  });
});
