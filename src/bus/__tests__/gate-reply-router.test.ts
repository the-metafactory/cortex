/**
 * `gate-reply-router` tests (Bot Packs B-3 / cortex#1021 W-1 — the adapter
 * inbound reply-bridge).
 *
 * Covered (plan W-1 probes):
 *   - matching offer resolves the waiting gate (consumed)
 *   - non-matching offer (other thread/channel/surface, or no thread) is
 *     NOT consumed — chat dispatch unaffected
 *   - timeout resolves null and deregisters the waiter
 *   - the re-await grace window: a reply in the gap is buffered (consumed)
 *     and delivered to the next awaitReply; expired buffers pass through
 *   - stop() resolves all pending null (drain cannot be held hostage)
 *   - FIFO across multiple gates on one key
 *   - END-TO-END with the real SurfacePrincipalGate: principal reply passes,
 *     impostor reply is ignored (pulse#47), non-principal message consumed by
 *     the open gate does not pass it
 */

import { describe, expect, test } from "bun:test";
import { GateReplyRouter, type GateReplyOffer } from "../gate-reply-router";
import {
  SurfacePrincipalGate,
  type GatePromptRenderer,
} from "../surface-principal-gate";

const PRINCIPAL_MM = "mm-principal-123";

function offerOf(over: Partial<GateReplyOffer> = {}): GateReplyOffer {
  return {
    surface: "mattermost",
    channel: "c1",
    thread: "th1",
    authorId: PRINCIPAL_MM,
    text: "run it",
    ...over,
  };
}

function nullRenderer(): GatePromptRenderer {
  return { render: () => undefined };
}

describe("GateReplyRouter", () => {
  test("matching offer resolves the waiting gate and is consumed", async () => {
    const router = new GateReplyRouter();
    const pending = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 5_000,
    });
    expect(router.pendingCount).toBe(1);
    expect(router.offer(offerOf())).toBe(true); // consumed
    const reply = await pending;
    expect(reply).toEqual({ authorId: PRINCIPAL_MM, text: "run it" });
    expect(router.pendingCount).toBe(0);
  });

  test("non-matching offer is NOT consumed — chat dispatch unaffected", async () => {
    const router = new GateReplyRouter();
    const pending = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 50,
    });
    // Different thread, different channel, different surface, and no thread
    // at all — none of these belong to the open gate.
    expect(router.offer(offerOf({ thread: "other" }))).toBe(false);
    expect(router.offer(offerOf({ channel: "other" }))).toBe(false);
    expect(router.offer(offerOf({ surface: "discord" }))).toBe(false);
    const noThread = offerOf();
    delete noThread.thread;
    expect(router.offer(noThread)).toBe(false);
    // The gate is still waiting; it times out to null.
    expect(await pending).toBeNull();
  });

  test("with NO open gate (and no grace window), every offer passes through", () => {
    const router = new GateReplyRouter();
    expect(router.offer(offerOf())).toBe(false);
  });

  test("timeout resolves null and deregisters", async () => {
    const router = new GateReplyRouter();
    const reply = await router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 10,
    });
    expect(reply).toBeNull();
    expect(router.pendingCount).toBe(0);
    // A waiter TIMEOUT opens no grace window — the late reply passes through.
    expect(router.offer(offerOf())).toBe(false);
  });

  test("non-positive timeout resolves null immediately", async () => {
    const router = new GateReplyRouter();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1",
        thread: "th1",
        timeoutMs: 0,
      }),
    ).toBeNull();
  });

  test("empty channel/thread keys never wait (gate fail-closes upstream)", async () => {
    const router = new GateReplyRouter();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "",
        thread: "th1",
        timeoutMs: 1_000,
      }),
    ).toBeNull();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1",
        thread: "",
        timeoutMs: 1_000,
      }),
    ).toBeNull();
  });

  test("separator-bearing ids never form a key — gate fails closed, offer passes through", async () => {
    const router = new GateReplyRouter();
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1\u001fx",
        thread: "th1",
        timeoutMs: 1_000,
      }),
    ).toBeNull();
    const pending = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 50,
    });
    expect(router.offer(offerOf({ thread: "th1\u001fmattermost" }))).toBe(false);
    expect(await pending).toBeNull();
  });

  test("re-await gap: a reply after a delivery is buffered (consumed) and handed to the next awaitReply", async () => {
    const router = new GateReplyRouter();
    const first = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 5_000,
    });
    // Delivery #1 (e.g. an impostor reply) — opens the grace window.
    expect(router.offer(offerOf({ authorId: "impostor", text: "run it" }))).toBe(true);
    expect((await first)?.authorId).toBe("impostor");
    // The gap: no waiter registered yet, but the key is hot — the principal's
    // reply must be CONSUMED (buffered), never become a chat dispatch.
    expect(router.offer(offerOf({ text: "yes" }))).toBe(true);
    // The gate's re-await drains the buffer immediately.
    const second = await router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 5_000,
    });
    expect(second).toEqual({ authorId: PRINCIPAL_MM, text: "yes" });
  });

  test("grace window is bounded: an unrelated key never buffers", () => {
    const router = new GateReplyRouter();
    const pending = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 1_000,
    });
    expect(router.offer(offerOf())).toBe(true); // delivery — c1/th1 hot
    // A different thread is NOT hot — passes through.
    expect(router.offer(offerOf({ thread: "th2" }))).toBe(false);
    return pending;
  });

  test("stop() resolves all pending null and rejects later traffic", async () => {
    const router = new GateReplyRouter();
    const a = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 60_000,
    });
    const b = router.awaitReply({
      surface: "discord",
      channel: "c2",
      thread: "th2",
      timeoutMs: 60_000,
    });
    router.stop();
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(router.pendingCount).toBe(0);
    expect(router.offer(offerOf())).toBe(false);
    expect(
      await router.awaitReply({
        surface: "mattermost",
        channel: "c1",
        thread: "th1",
        timeoutMs: 60_000,
      }),
    ).toBeNull();
  });

  test("FIFO across multiple gates on one key", async () => {
    const router = new GateReplyRouter();
    const first = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 5_000,
    });
    const second = router.awaitReply({
      surface: "mattermost",
      channel: "c1",
      thread: "th1",
      timeoutMs: 50,
    });
    expect(router.pendingCount).toBe(2);
    expect(router.offer(offerOf({ text: "yes" }))).toBe(true);
    expect((await first)?.text).toBe("yes");
    // The second waiter is untouched and times out on its own.
    expect(await second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real gate + real router. The renderer is a stub: prompt RENDERING rides the
// dispatch.task.post path (dispatch sink), which is outside the W-1 bridge —
// what this section proves is the await/identity/verdict path over the router.
// ---------------------------------------------------------------------------

describe("SurfacePrincipalGate over GateReplyRouter (renderer stubbed — prompt delivery belongs to the dispatch sink, not this bridge)", () => {
  function liveGate(router: GateReplyRouter): SurfacePrincipalGate {
    return new SurfacePrincipalGate({
      principalIdentity: { mattermostId: PRINCIPAL_MM },
      liveSurfaces: new Set(["mattermost"]),
      renderer: nullRenderer(),
      replySource: router,
      timeoutMs: 2_000,
    });
  }

  function resolveGate(gate: SurfacePrincipalGate) {
    return gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run this flow?",
      source: { surface: "mattermost", channel: "c1", thread: "th1", user: "u1" },
    });
  }

  /** Yield until the gate's awaitReply registration lands in the router. */
  async function untilPending(router: GateReplyRouter): Promise<void> {
    for (let i = 0; i < 50 && router.pendingCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(router.pendingCount).toBeGreaterThan(0);
  }

  test("principal reply in the gate thread passes the gate", async () => {
    const router = new GateReplyRouter();
    const gate = liveGate(router);
    const verdictP = resolveGate(gate);
    await untilPending(router);
    expect(router.offer(offerOf({ text: "run it" }))).toBe(true);
    const verdict = await verdictP;
    expect(verdict.verdict).toBe("pass");
    expect(verdict.principal).toBe(PRINCIPAL_MM);
  });

  test("impostor 'run it' is consumed by the open gate but never passes it (pulse#47)", async () => {
    const router = new GateReplyRouter();
    const gate = liveGate(router);
    const verdictP = resolveGate(gate);
    await untilPending(router);
    // The impostor's reply IS a gate-thread reply — consumed — but the gate
    // ignores the non-principal author and re-awaits.
    expect(router.offer(offerOf({ authorId: "impostor", text: "run it" }))).toBe(true);
    // The principal's denial can land in the re-await gap — the grace buffer
    // consumes it and the gate's next awaitReply receives it.
    expect(router.offer(offerOf({ text: "no" }))).toBe(true);
    const verdict = await verdictP;
    expect(verdict.verdict).toBe("fail");
    expect(verdict.principal).toBe(PRINCIPAL_MM);
  });

  test("router.stop() with an open gate fails it closed (drain path)", async () => {
    const router = new GateReplyRouter();
    const gate = liveGate(router);
    const verdictP = resolveGate(gate);
    await untilPending(router);
    router.stop();
    const verdict = await verdictP;
    expect(verdict.verdict).toBe("fail");
  });
});
