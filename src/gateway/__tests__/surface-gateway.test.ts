/**
 * cortex#524 GW.a.2 — SurfaceGateway inbound orchestrator tests (TDD Red→Green).
 *
 * Tests cover:
 *
 *   1. start() wires all adapters' onMessage to handleInbound
 *   2. stop() stops all adapters
 *   3. Routable inbound (Discord) → correct decision + responseRouting
 *   4. Routable inbound (Slack) → correct decision + responseRouting
 *   5. Routable inbound (Mattermost single-binding) → correct decision
 *   6. Thread ID present → thread_id on responseRouting
 *   7. No thread ID → thread_id absent on responseRouting
 *   8. Unroutable inbound (DM / no guildId) → onUnroutable called, sink NOT called
 *   9. Unroutable inbound (unknown guildId) → onUnroutable called, sink NOT called
 *  10. Mattermost multi-binding → onUnroutable called, sink NOT called
 *  11. Sink throws → error logged to stderr, loop survives (no throw escapes)
 *  12. Default onUnroutable (console.warn) fires when no custom handler provided
 *  13. LoggingInboundSink.publish writes to stdout (shadow stage)
 */

import { describe, expect, test } from "bun:test";
import {
  SurfaceGateway,
  LoggingInboundSink,
  type GatewayInboundDecision,
  type GatewayInboundSink,
} from "../surface-gateway";
import { buildBindingIndex } from "../binding-resolver";
import type { PlatformAdapter, InboundMessage } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import { testRegistryWithWeb } from "./test-registry-support";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const DISCORD_SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        token: "tok-luna-discord",
        guildId: "555555555555555555",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
  ],
};

const SLACK_SURFACES: Surfaces = {
  slack: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        botToken: "xoxb-111-222-abc",
        appToken: "xapp-1-333-444-def",
        workspaceId: "T0123456789",
      },
    },
  ],
};

const MATTERMOST_SINGLE_SURFACES: Surfaces = {
  mattermost: [
    {
      agent: "luna",
      stack: "andreas/work",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-tok-abc",
      },
    },
  ],
};

const MATTERMOST_MULTI_SURFACES: Surfaces = {
  mattermost: [
    {
      agent: "luna",
      stack: "andreas/work",
      binding: { apiUrl: "https://mm.work.example.com", apiToken: "mm-tok-work" },
    },
    {
      agent: "echo",
      stack: "andreas/meta-factory",
      binding: { apiUrl: "https://mm.mf.example.com", apiToken: "mm-tok-mf" },
    },
  ],
};

/** Minimal valid InboundMessage for tests that only care about routing fields */
function msg(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "discord",
    instanceId: "discord-luna-mf",
    authorId: "u1",
    authorName: "Test User",
    content: "hello gateway",
    channelId: "ch-100",
    attachments: [],
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ─── MockAdapter ─────────────────────────────────────────────────────────────

/**
 * Minimal PlatformAdapter mock.
 *
 * Captures the `onMessage` callback so tests can drive inbound messages
 * directly via `trigger(msg)`. `start()` / `stop()` are observable via
 * `startCalled` / `stopCalled` counts.
 */
class MockAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly instanceId: string;

  startCalled = 0;
  stopCalled = 0;
  attachCalled = 0;
  /** Records start/attach order so tests can assert attach happens AFTER start. */
  readonly callOrder: string[] = [];

  private _onMessage: ((msg: InboundMessage) => Promise<void>) | null = null;

  constructor(platform: string, instanceId: string) {
    this.platform = platform;
    this.instanceId = instanceId;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.startCalled++;
    this.callOrder.push("start");
    this._onMessage = onMessage;
  }

  attachInboundDispatch(): void {
    this.attachCalled++;
    this.callOrder.push("attach");
  }

  async stop(): Promise<void> {
    this.stopCalled++;
    this._onMessage = null;
  }

  /** Drive an inbound message through the registered onMessage callback. */
  async trigger(inbound: InboundMessage): Promise<void> {
    if (!this._onMessage) throw new Error("adapter not started");
    await this._onMessage(inbound);
  }

  // ── stubs for the rest of PlatformAdapter ─────────────────────────────────

  async getPlatformUserId(): Promise<string> {
    return "bot-user-id";
  }

  async fetchContext() {
    return [];
  }

  resolveAccess() {
    return {
      allowed: true,
      features: { chat: true, async: false, team: false },
    };
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

// ─── FakeSink ─────────────────────────────────────────────────────────────────

/** Capturing sink — records every publish call for assertion. */
class FakeSink implements GatewayInboundSink {
  readonly calls: { decision: GatewayInboundDecision; msg: InboundMessage }[] =
    [];

  /** Set to make publish() throw — `unknown` so non-Error throws are exercisable. */
  shouldThrow: unknown = null;

  async publish(decision: GatewayInboundDecision, msg: InboundMessage): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- a test deliberately throws a non-Error value to exercise handleInbound's String(err) defensive branch (production sinks may be JS that throws non-Errors)
    if (this.shouldThrow !== null) throw this.shouldThrow;
    this.calls.push({ decision, msg });
  }
}

// ─── 1. start() wires all adapters ───────────────────────────────────────────

describe("SurfaceGateway.start()", () => {
  test("calls start() on every adapter", async () => {
    const a1 = new MockAdapter("discord", "disc-1");
    const a2 = new MockAdapter("slack", "slack-1");
    const index = buildBindingIndex({});
    const sink = new FakeSink();
    const gw = new SurfaceGateway([a1, a2], index, sink);

    await gw.start();

    expect(a1.startCalled).toBe(1);
    expect(a2.startCalled).toBe(1);
    // Two-phase inbound: start() must ALSO attach the message listener, or the
    // adapter connects but never delivers inbound (the cortex#524 dry-run bug).
    expect(a1.attachCalled).toBe(1);
    expect(a2.attachCalled).toBe(1);
    // attach MUST come after start (start stores onMessage; attach registers the listener).
    expect(a1.callOrder).toEqual(["start", "attach"]);
    expect(a2.callOrder).toEqual(["start", "attach"]);
  });
});

// ─── 2. stop() stops all adapters ────────────────────────────────────────────

describe("SurfaceGateway.stop()", () => {
  test("calls stop() on every adapter", async () => {
    const a1 = new MockAdapter("discord", "disc-1");
    const a2 = new MockAdapter("slack", "slack-1");
    const index = buildBindingIndex({});
    const sink = new FakeSink();
    const gw = new SurfaceGateway([a1, a2], index, sink);

    await gw.start();
    await gw.stop();

    expect(a1.stopCalled).toBe(1);
    expect(a2.stopCalled).toBe(1);
  });
});

// ─── 3. Routable inbound (Discord) ───────────────────────────────────────────

describe("handleInbound — routable Discord message", () => {
  test("publishes correct decision with match + responseRouting", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();
    const gw = new SurfaceGateway([adapter], index, sink);
    await gw.start();

    const inbound = msg({
      platform: "discord",
      instanceId: "discord-luna-mf",
      guildId: "555555555555555555",
      channelId: "ch-9000",
    });
    await adapter.trigger(inbound);

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call).toBeDefined();

    const { decision } = call!;
    expect(decision.match.platform).toBe("discord");
    expect(decision.match.agent).toBe("luna");
    expect(decision.match.principal).toBe("andreas");
    expect(decision.match.stack).toBe("meta-factory");
    expect(decision.match.instance).toBe("discord:555555555555555555");

    expect(decision.responseRouting.adapter_instance).toBe("discord-luna-mf");
    expect(decision.responseRouting.channel_id).toBe("ch-9000");
    expect(decision.responseRouting.thread_id).toBeUndefined();
  });
});

// ─── 4. Routable inbound (Slack) ─────────────────────────────────────────────

describe("handleInbound — routable Slack message", () => {
  test("publishes correct decision", async () => {
    const adapter = new MockAdapter("slack", "slack-luna-mf");
    const index = buildBindingIndex(SLACK_SURFACES);
    const sink = new FakeSink();
    const gw = new SurfaceGateway([adapter], index, sink);
    await gw.start();

    const inbound = msg({
      platform: "slack",
      instanceId: "slack-luna-mf",
      guildId: "T0123456789", // Slack workspaceId maps to guildId on InboundMessage
      channelId: "C111222333",
    });
    await adapter.trigger(inbound);

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call).toBeDefined();

    const { decision } = call!;
    expect(decision.match.platform).toBe("slack");
    expect(decision.match.agent).toBe("luna");
    expect(decision.responseRouting.adapter_instance).toBe("slack-luna-mf");
    expect(decision.responseRouting.channel_id).toBe("C111222333");
  });
});

// ─── 5. Routable inbound (Mattermost single-binding) ─────────────────────────

describe("handleInbound — routable Mattermost single-binding", () => {
  test("publishes correct decision via single-binding fallback", async () => {
    const adapter = new MockAdapter("mattermost", "mm-luna");
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES, testRegistryWithWeb());
    const sink = new FakeSink();
    const gw = new SurfaceGateway([adapter], index, sink);
    await gw.start();

    const inbound = msg({
      platform: "mattermost",
      instanceId: "mm-luna",
      channelId: "ch-mm-1",
    });
    await adapter.trigger(inbound);

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call).toBeDefined();

    const { decision } = call!;
    expect(decision.match.platform).toBe("mattermost");
    expect(decision.match.agent).toBe("luna");
    expect(decision.match.principal).toBe("andreas");
    expect(decision.match.stack).toBe("work");
    expect(decision.responseRouting.adapter_instance).toBe("mm-luna");
  });
});

// ─── 6. Thread ID present → thread_id on responseRouting ─────────────────────

describe("handleInbound — thread_id propagation", () => {
  test("thread_id is set on responseRouting when msg.threadId is present", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();
    const gw = new SurfaceGateway([adapter], index, sink);
    await gw.start();

    const inbound = msg({
      platform: "discord",
      instanceId: "discord-luna-mf",
      guildId: "555555555555555555",
      channelId: "ch-9000",
      threadId: "thread-42",
    });
    await adapter.trigger(inbound);

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call).toBeDefined();
    expect(call!.decision.responseRouting.thread_id).toBe("thread-42");
  });

  test("thread_id is absent on responseRouting when msg.threadId is undefined", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();
    const gw = new SurfaceGateway([adapter], index, sink);
    await gw.start();

    const inbound = msg({
      platform: "discord",
      instanceId: "discord-luna-mf",
      guildId: "555555555555555555",
      channelId: "ch-9000",
      threadId: undefined,
    });
    await adapter.trigger(inbound);

    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call).toBeDefined();
    expect("thread_id" in call!.decision.responseRouting).toBe(false);
  });
});

// ─── 8. Unroutable inbound (DM / no guildId) ─────────────────────────────────

describe("handleInbound — unroutable (DM)", () => {
  test("onUnroutable is called, sink is NOT called", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();

    const unroutableCalls: { msg: InboundMessage; reason: string }[] = [];
    const gw = new SurfaceGateway([adapter], index, sink, {
      onUnroutable: (m, r) => {
        unroutableCalls.push({ msg: m, reason: r });
      },
    });
    await gw.start();

    // DM — no guildId
    const inbound = msg({
      platform: "discord",
      instanceId: "discord-luna-mf",
      channelId: "dm-ch",
      isDM: true,
    });
    await adapter.trigger(inbound);

    expect(unroutableCalls).toHaveLength(1);
    expect(unroutableCalls[0]).toBeDefined();
    expect(unroutableCalls[0]!.reason).toContain("DM");
    expect(sink.calls).toHaveLength(0);
  });
});

// ─── 9. Unroutable inbound (unknown guildId) ─────────────────────────────────

describe("handleInbound — unroutable (unknown guildId)", () => {
  test("onUnroutable is called with no-binding reason, sink is NOT called", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();

    const unroutableCalls: string[] = [];
    const gw = new SurfaceGateway([adapter], index, sink, {
      onUnroutable: (_m, r) => {
        unroutableCalls.push(r);
      },
    });
    await gw.start();

    const inbound = msg({
      platform: "discord",
      instanceId: "discord-luna-mf",
      guildId: "999999999999999999", // not in the index
      channelId: "ch-x",
    });
    await adapter.trigger(inbound);

    expect(unroutableCalls).toHaveLength(1);
    expect(unroutableCalls[0]).toBeDefined();
    expect(unroutableCalls[0]!).toContain("no binding");
    expect(sink.calls).toHaveLength(0);
  });
});

// ─── 10. Mattermost multi-binding → unroutable ───────────────────────────────

describe("handleInbound — mattermost multi-binding (unroutable)", () => {
  test("onUnroutable is called with multi-binding reason, sink NOT called", async () => {
    const adapter = new MockAdapter("mattermost", "mm-multi");
    const index = buildBindingIndex(MATTERMOST_MULTI_SURFACES);
    const sink = new FakeSink();

    const unroutableCalls: string[] = [];
    const gw = new SurfaceGateway([adapter], index, sink, {
      onUnroutable: (_m, r) => {
        unroutableCalls.push(r);
      },
    });
    await gw.start();

    const inbound = msg({
      platform: "mattermost",
      instanceId: "mm-multi",
      channelId: "ch-mm",
    });
    await adapter.trigger(inbound);

    expect(unroutableCalls).toHaveLength(1);
    expect(unroutableCalls[0]).toBeDefined();
    expect(unroutableCalls[0]!).toContain("multi-binding");
    expect(sink.calls).toHaveLength(0);
  });
});

// ─── 11. Sink throws → logged, loop survives ──────────────────────────────────

describe("handleInbound — sink throws", () => {
  test("sink error is logged to stderr, no throw escapes handleInbound", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();
    sink.shouldThrow = new Error("bus not connected");

    const stderrChunks: string[] = [];
    const savedWrite: typeof process.stderr.write = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") stderrChunks.push(chunk);
      return savedWrite.call(process.stderr, chunk);
    };

    try {
      const gw = new SurfaceGateway([adapter], index, sink);
      await gw.start();

      const inbound = msg({
        platform: "discord",
        instanceId: "discord-luna-mf",
        guildId: "555555555555555555",
        channelId: "ch-9000",
      });

      // Must not throw
      await expect(adapter.trigger(inbound)).resolves.toBeUndefined();

      // Error should have been written to stderr
      const combined = stderrChunks.join("");
      expect(combined).toContain("handleInbound error");
      expect(combined).toContain("bus not connected");
    } finally {
      process.stderr.write = savedWrite;
    }
  });

  test("non-Error sink throw is stringified, no throw escapes", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();
    sink.shouldThrow = "boom-string"; // non-Error throw value → String(err) branch

    const stderrChunks: string[] = [];
    const savedWrite: typeof process.stderr.write = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") stderrChunks.push(chunk);
      return savedWrite.call(process.stderr, chunk);
    };

    try {
      const gw = new SurfaceGateway([adapter], index, sink);
      await gw.start();
      const inbound = msg({
        platform: "discord",
        instanceId: "discord-luna-mf",
        guildId: "555555555555555555",
        channelId: "ch-9000",
      });
      await expect(adapter.trigger(inbound)).resolves.toBeUndefined();
      expect(stderrChunks.join("")).toContain("boom-string");
    } finally {
      process.stderr.write = savedWrite;
    }
  });
});

// ─── 12. onUnroutable hook throws → caught, loop survives ─────────────────────

describe("handleInbound — onUnroutable hook throws", () => {
  test("a throwing onUnroutable is caught, no throw escapes the adapter loop", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();

    const stderrChunks: string[] = [];
    const savedWrite: typeof process.stderr.write = process.stderr.write;
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") stderrChunks.push(chunk);
      return savedWrite.call(process.stderr, chunk);
    };

    try {
      const gw = new SurfaceGateway([adapter], index, sink, {
        onUnroutable: () => {
          throw new Error("hook blew up");
        },
      });
      await gw.start();

      // DM → unroutable → onUnroutable throws; handleInbound must still not throw.
      const inbound = msg({
        platform: "discord",
        instanceId: "discord-luna-mf",
        channelId: "dm-ch",
        isDM: true,
      });
      await expect(adapter.trigger(inbound)).resolves.toBeUndefined();

      const combined = stderrChunks.join("");
      expect(combined).toContain("handleInbound error");
      expect(combined).toContain("hook blew up");
      expect(sink.calls).toHaveLength(0);
    } finally {
      process.stderr.write = savedWrite;
    }
  });
});

// ─── 12. Default onUnroutable (console.warn) ─────────────────────────────────

describe("SurfaceGateway — default onUnroutable", () => {
  test("console.warn is called when no custom handler is provided", async () => {
    const adapter = new MockAdapter("discord", "discord-luna-mf");
    const index = buildBindingIndex(DISCORD_SURFACES);
    const sink = new FakeSink();
    // No onUnroutable option — default should call console.warn
    const gw = new SurfaceGateway([adapter], index, sink);
    await gw.start();

    const warnMessages: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(...args);
    };

    try {
      const inbound = msg({
        platform: "discord",
        instanceId: "discord-luna-mf",
        channelId: "dm-ch",
        // no guildId → DM → unroutable
      });
      await adapter.trigger(inbound);

      expect(warnMessages.length).toBeGreaterThan(0);
      const warnStr = String(warnMessages[0]);
      expect(warnStr).toContain("unroutable");
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─── 13. LoggingInboundSink writes to stdout ─────────────────────────────────

describe("LoggingInboundSink", () => {
  test("publish writes a shadow-stage log line to stdout", async () => {
    const sink = new LoggingInboundSink();
    const index = buildBindingIndex(DISCORD_SURFACES);
    const match = {
      platform: "discord" as const,
      agent: "luna",
      principal: "andreas",
      stack: "meta-factory",
      instance: "discord:555555555555555555",
    };
    const decision: GatewayInboundDecision = {
      match,
      responseRouting: {
        adapter_instance: "discord-luna-mf",
        channel_id: "ch-9000",
        thread_id: "t-42",
      },
    };
    const inbound = msg({
      platform: "discord",
      instanceId: "discord-luna-mf",
      guildId: "555555555555555555",
      channelId: "ch-9000",
      threadId: "t-42",
    });

    const stdoutChunks: string[] = [];
    const savedWrite: typeof process.stdout.write = process.stdout.write;
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") stdoutChunks.push(chunk);
      return savedWrite.call(process.stdout, chunk);
    };

    try {
      await sink.publish(decision, inbound);

      const combined = stdoutChunks.join("");
      expect(combined).toContain("[surface-gateway:shadow]");
      expect(combined).toContain("platform=discord");
      expect(combined).toContain("agent=luna");
      expect(combined).toContain("principal=andreas");
      expect(combined).toContain("stack=meta-factory");
      expect(combined).toContain("adapter_instance=discord-luna-mf");
      expect(combined).toContain("channel_id=ch-9000");
      expect(combined).toContain("thread_id=t-42");
      // Unused variable suppressed intentionally
      void index;
    } finally {
      process.stdout.write = savedWrite;
    }
  });
});
