/**
 * cortex#1793 (S8, ADR-0024 D3) — SurfaceGateway runtime attach/detach tests.
 *
 * Covers the acceptance criterion from the issue: "Detach of one adapter
 * leaves every other adapter delivering (test with two mock adapters through
 * the real gateway)", plus:
 *
 *   1. attachAdapter folds discord/slack/web seeds into the live index and
 *      inbound routes correctly afterward.
 *   2. attachAdapter refuses a duplicate instanceId / a colliding demux key
 *      (mirrors buildBindingIndex's loud boot-time throw).
 *   3. detachAdapter removes exactly the detached instance's index entries —
 *      a second, still-attached instance keeps delivering (the acceptance
 *      criterion).
 *   4. detachAdapter DRAINS: an in-flight handleInbound call started before
 *      detach completes before adapter.stop() is invoked; new inbound
 *      arriving DURING the drain window is dropped (not routed), not queued.
 *   5. detachAdapter on an unknown instanceId is a no-op ({ detached: false }).
 *   6. mattermost single/multi recompute across attach/detach.
 */

import { describe, expect, test } from "bun:test";
import {
  SurfaceGateway,
  type GatewayInboundDecision,
  type GatewayInboundSink,
  type GatewayBindingSeed,
} from "../surface-gateway";
import { buildBindingIndex } from "../binding-resolver";
import type { PlatformAdapter, InboundMessage } from "../../adapters/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

class MockAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly instanceId: string;
  startCalled = 0;
  stopCalled = 0;
  attachCalled = 0;

  private _onMessage: ((msg: InboundMessage) => Promise<void>) | null = null;

  constructor(platform: string, instanceId: string) {
    this.platform = platform;
    this.instanceId = instanceId;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.startCalled++;
    this._onMessage = onMessage;
  }

  attachInboundDispatch(): void {
    this.attachCalled++;
  }

  async stop(): Promise<void> {
    this.stopCalled++;
    this._onMessage = null;
  }

  async trigger(inbound: InboundMessage): Promise<void> {
    if (!this._onMessage) throw new Error("adapter not started");
    await this._onMessage(inbound);
  }

  async getPlatformUserId(): Promise<string> {
    return "bot-user-id";
  }
  async fetchContext() {
    return [];
  }
  resolveAccess() {
    return { allowed: true, features: { chat: true, async: false, team: false } };
  }
  async postResponse() {}
  async sendTyping() {}
  async sendProgress() {}
  async clearProgress() {}
  async createThread() {
    return { instanceId: this.instanceId, channelId: "new-thread" };
  }
  async resolveLogicalTarget() {
    return null;
  }
  async notifyPrincipal() {}
}

/** A sink whose publish() can be held open by the test (deferred resolve) —
 *  used to simulate an in-flight handleInbound call during a detach. */
class DeferredSink implements GatewayInboundSink {
  readonly calls: { decision: GatewayInboundDecision; msg: InboundMessage }[] = [];
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** Hold every subsequent publish() open until `resolveGate()` is called. */
  holdOpen(): void {
    this.gate = new Promise((res) => {
      this.release = res;
    });
  }

  resolveGate(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  async publish(decision: GatewayInboundDecision, msg: InboundMessage): Promise<void> {
    if (this.gate) await this.gate;
    this.calls.push({ decision, msg });
  }
}

function msg(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "discord",
    instanceId: "discord-a",
    authorId: "u1",
    authorName: "Test User",
    content: "hello",
    channelId: "ch-1",
    attachments: [],
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const DISCORD_SEED_A: GatewayBindingSeed = {
  platform: "discord",
  agent: "luna",
  stack: "andreas/meta-factory",
  demuxKey: "guild-a",
};

const DISCORD_SEED_B: GatewayBindingSeed = {
  platform: "discord",
  agent: "echo",
  stack: "andreas/work",
  demuxKey: "guild-b",
};

// ─── 1 & 2 — attachAdapter ───────────────────────────────────────────────────

describe("SurfaceGateway.attachAdapter()", () => {
  test("folds seeds into the index and routes inbound afterward", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const adapter = new MockAdapter("discord", "disc-a");

    await gw.attachAdapter(adapter, [DISCORD_SEED_A]);

    expect(adapter.startCalled).toBe(1);
    expect(adapter.attachCalled).toBe(1);

    await adapter.trigger(msg({ instanceId: "disc-a", guildId: "guild-a" }));
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.decision.match.agent).toBe("luna");
  });

  test("throws on a duplicate instanceId and does not mutate state", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const a1 = new MockAdapter("discord", "dup");
    const a2 = new MockAdapter("discord", "dup");
    await gw.attachAdapter(a1, [DISCORD_SEED_A]);

    await expect(
      gw.attachAdapter(a2, [{ ...DISCORD_SEED_A, demuxKey: "guild-c" }]),
    ).rejects.toThrow(/already attached/);
    expect(a2.startCalled).toBe(0);
  });

  test("throws on a colliding demux key across two distinct instances", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const a1 = new MockAdapter("discord", "disc-a");
    const a2 = new MockAdapter("discord", "disc-b");
    await gw.attachAdapter(a1, [DISCORD_SEED_A]);

    await expect(gw.attachAdapter(a2, [DISCORD_SEED_A])).rejects.toThrow(/ambiguous discord config/);
    expect(a2.startCalled).toBe(0);
  });
});

// ─── 3 — detach isolation (the acceptance criterion) ────────────────────────

describe("SurfaceGateway.detachAdapter() — isolation", () => {
  test("detaching one instance leaves the other still delivering", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const a1 = new MockAdapter("discord", "disc-a");
    const a2 = new MockAdapter("discord", "disc-b");
    await gw.attachAdapter(a1, [DISCORD_SEED_A]);
    await gw.attachAdapter(a2, [DISCORD_SEED_B]);

    const result = await gw.detachAdapter("disc-a");
    expect(result).toEqual({ detached: true });
    // a1 was stopped (its own onMessage callback is torn down by MockAdapter's
    // stop() — the platform connection is gone) — a2 was never touched.
    expect(a1.stopCalled).toBe(1);
    expect(a2.stopCalled).toBe(0);

    // a2 still resolves + delivers.
    await a2.trigger(msg({ instanceId: "disc-b", guildId: "guild-b" }));
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.decision.match.agent).toBe("echo");
  });

  test("detaching an unknown instanceId is a no-op", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const result = await gw.detachAdapter("does-not-exist");
    expect(result).toEqual({ detached: false });
  });
});

// ─── 4 — drain ───────────────────────────────────────────────────────────────

describe("SurfaceGateway.detachAdapter() — drain", () => {
  test("awaits an in-flight handleInbound call before stop(), and drops inbound arriving during the drain", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const adapter = new MockAdapter("discord", "disc-a");
    await gw.attachAdapter(adapter, [DISCORD_SEED_A]);

    // Hold the sink open so the in-flight handleInbound call doesn't resolve
    // until we release it.
    sink.holdOpen();
    const inFlight = adapter.trigger(msg({ instanceId: "disc-a", guildId: "guild-a" }));

    // Give the in-flight call a tick to register itself before detaching.
    await Promise.resolve();

    const detachPromise = gw.detachAdapter("disc-a");

    // Inbound arriving DURING the drain window (after the detach flag is
    // set) must be dropped, not routed — even though the adapter object is
    // still technically reachable in this test until stop() resolves.
    await adapter.trigger(msg({ instanceId: "disc-a", guildId: "guild-a", content: "late" }));

    // adapter.stop() must NOT have been called yet — the drain is still
    // waiting on the held-open sink.
    expect(adapter.stopCalled).toBe(0);

    sink.resolveGate();
    await inFlight;
    const result = await detachPromise;

    expect(result).toEqual({ detached: true });
    expect(adapter.stopCalled).toBe(1);
    // Exactly one publish — the original in-flight call. The late arrival
    // was dropped, not queued.
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.msg.content).toBe("hello");
  });
});

// ─── 5 — mattermost single/multi recompute ──────────────────────────────────

describe("SurfaceGateway attach/detach — mattermost single/multi recompute", () => {
  test("single mattermost attach sets the fallback slot; a second attach flips to ambiguous; detaching one restores single", async () => {
    const index = buildBindingIndex({});
    const sink = new DeferredSink();
    const gw = new SurfaceGateway([], index, sink);
    const a1 = new MockAdapter("mattermost", "mm-1");
    const a2 = new MockAdapter("mattermost", "mm-2");

    await gw.attachAdapter(a1, [
      { platform: "mattermost", agent: "luna", stack: "andreas/work", demuxKey: "https://mm1.example.com" },
    ]);
    await a1.trigger(msg({ platform: "mattermost", instanceId: "mm-1" }));
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.decision.match.agent).toBe("luna");

    await gw.attachAdapter(a2, [
      { platform: "mattermost", agent: "echo", stack: "andreas/meta-factory", demuxKey: "https://mm2.example.com" },
    ]);
    // Now ambiguous — a fresh inbound cannot be demuxed.
    await a1.trigger(msg({ platform: "mattermost", instanceId: "mm-1", content: "ambiguous now" }));
    expect(sink.calls).toHaveLength(1); // unchanged — dropped as unroutable

    await gw.detachAdapter("mm-2");
    await a1.trigger(msg({ platform: "mattermost", instanceId: "mm-1", content: "single again" }));
    expect(sink.calls).toHaveLength(2);
    expect(sink.calls[1]?.decision.match.agent).toBe("luna");
  });
});
