/**
 * Regression: the Mattermost gate-orphan bug.
 *
 * The poller sets `rootId = post.root_id || post.id`, so a top-level post's
 * "rootId" is its OWN id. If that flows through as `InboundMessage.threadId`,
 * cortex's `threadId ?? channelId` collapse never fires and every top-level
 * post becomes its own phantom thread — a gate prompt and the principal's
 * separate top-level reply then key on different ids and never correlate, so
 * the reply spawns a NEW task instead of resolving the open gate.
 *
 * These tests lock the collapse: top-level → channel key (undefined threadId);
 * genuine thread → its root; and the outbound side never posts root_id=channel.
 */

import { describe, expect, it } from "bun:test";
import { inboundThreadId, outboundRootId } from "../index";

describe("inboundThreadId — top-level collapses, threads keep their root", () => {
  it("top-level post (rootId === postId) → undefined (collapses to channel)", () => {
    expect(inboundThreadId("post-1", "post-1")).toBeUndefined();
  });

  it("genuinely-threaded post (rootId !== postId) → the thread root", () => {
    expect(inboundThreadId("root-9", "post-2")).toBe("root-9");
  });

  it("two distinct top-level posts both collapse — so they share a key", () => {
    // The run command (P1) and the principal's separate 'yes' (P2): both
    // top-level, both → undefined → cortex keys both on channelId → MATCH.
    expect(inboundThreadId("P1", "P1")).toBeUndefined();
    expect(inboundThreadId("P2", "P2")).toBeUndefined();
  });
});

describe("outboundRootId — never post root_id=channel", () => {
  it("thread === channel (cortex's no-thread key) → undefined (top-level post)", () => {
    expect(outboundRootId("chan-1", "chan-1")).toBeUndefined();
  });

  it("undefined thread → undefined (top-level post)", () => {
    expect(outboundRootId(undefined, "chan-1")).toBeUndefined();
  });

  it("genuine thread root (≠ channel) → threads as usual", () => {
    expect(outboundRootId("root-9", "chan-1")).toBe("root-9");
  });
});
