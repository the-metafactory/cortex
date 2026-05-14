/**
 * MIG-7.2c-binding — PresenceBinding tests.
 *
 * Covers the start-then-register / unregister-then-stop lifecycle, the
 * unsupported-platform guard, the partial-failure rollback path, and the
 * idempotent re-bind / unbind semantics. Uses an inline `FakeAdapter` that
 * mimics enough of `PlatformAdapter` for the binding's purposes —
 * MockAdapter has `platform = "mock"` which the binding rejects, so we
 * need a fake that pretends to be discord/mattermost.
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  AgentNotFoundError,
  AgentRegistry,
} from "../registry";
import {
  PresenceBinding,
  UnsupportedPlatformError,
} from "../presence-binding";
import {
  PlatformIdAlreadyRegisteredError,
  TrustResolver,
  type Platform,
} from "../trust-resolver";
import type { Agent } from "../../types/cortex-config";
import type {
  AccessDecision,
  ContextMessage,
  InboundMessage,
  OutboundFile,
  PlatformAdapter,
  ResponseTarget,
} from "../../../adapters/types";

// =============================================================================
// FakeAdapter — minimal PlatformAdapter that pretends to be `discord` or
// `mattermost`. Tracks lifecycle calls so tests can assert on the order
// the binding invokes start / getPlatformUserId / stop.
// =============================================================================

class FakeAdapter implements PlatformAdapter {
  readonly platform: string;
  readonly instanceId: string;
  /** What `getPlatformUserId()` resolves to. */
  platformUserId: string;
  /** If non-null, `start()` rejects with this error. */
  startError: Error | null = null;
  /** If non-null, `getPlatformUserId()` rejects with this error. */
  getPlatformUserIdError: Error | null = null;
  /** If non-null, `stop()` rejects with this error. */
  stopError: Error | null = null;

  // Call recorders
  readonly calls: string[] = [];

  constructor(opts: {
    platform: string;
    instanceId?: string;
    platformUserId?: string;
  }) {
    this.platform = opts.platform;
    this.instanceId = opts.instanceId ?? `${opts.platform}-fake`;
    this.platformUserId = opts.platformUserId ?? `${opts.platform}-bot-userid`;
  }

  async start(_onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.calls.push("start");
    if (this.startError) throw this.startError;
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    if (this.stopError) throw this.stopError;
  }

  async getPlatformUserId(): Promise<string> {
    this.calls.push("getPlatformUserId");
    if (this.getPlatformUserIdError) throw this.getPlatformUserIdError;
    return this.platformUserId;
  }

  async fetchContext(_msg: InboundMessage, _depth: number): Promise<ContextMessage[]> {
    return [];
  }
  resolveAccess(_msg: InboundMessage): AccessDecision {
    return { allowed: true, features: { chat: true, async: true, team: true } };
  }
  async postResponse(_t: ResponseTarget, _text: string, _files?: OutboundFile[]) {}
  async sendTyping(_t: ResponseTarget) {}
  async sendProgress(_t: ResponseTarget, _text: string) {}
  async clearProgress(_t: ResponseTarget) {}
  async createThread(msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    return { instanceId: this.instanceId, channelId: msg.channelId };
  }
  async notifyOperator(_text: string) {}
}

// =============================================================================
// Fixtures (registry + trust resolver)
// =============================================================================

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
    contextDepth: 10,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: {
      operatorRole: {
        features: ["chat", "async", "team"] as const,
        disallowedTools: [],
        bashGuard: true,
      },
      defaultRole: "denied" as const,
      userRoles: [],
    },
  };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function noopMessageHandler(): (msg: InboundMessage) => Promise<void> {
  return async () => {};
}

// =============================================================================
// Construction
// =============================================================================

describe("PresenceBinding — construction", () => {
  let registry: AgentRegistry;
  let resolver: TrustResolver;

  beforeEach(() => {
    registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    resolver = new TrustResolver(registry);
  });

  test("accepts a discord-platform adapter", () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    const binding = new PresenceBinding("luna", adapter, resolver);
    expect(binding.registeredPlatform).toBe("discord");
    expect(binding.registeredAgentId).toBe("luna");
    expect(binding.registeredPlatformId).toBeUndefined();
  });

  test("accepts a mattermost-platform adapter", () => {
    const adapter = new FakeAdapter({ platform: "mattermost" });
    const binding = new PresenceBinding("luna", adapter, resolver);
    expect(binding.registeredPlatform).toBe("mattermost");
  });

  test("rejects an unknown platform with UnsupportedPlatformError", () => {
    const adapter = new FakeAdapter({ platform: "mock" });
    expect(() => new PresenceBinding("luna", adapter, resolver))
      .toThrow(UnsupportedPlatformError);
  });

  test("UnsupportedPlatformError carries the offending platform and known list", () => {
    const adapter = new FakeAdapter({ platform: "slack" });
    try {
      new PresenceBinding("luna", adapter, resolver);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedPlatformError);
      const e = err as UnsupportedPlatformError;
      expect(e.platform).toBe("slack");
      expect(e.knownPlatforms).toEqual(["discord", "mattermost"]);
    }
  });
});

// =============================================================================
// startAndBind — happy path
// =============================================================================

describe("PresenceBinding.startAndBind", () => {
  let registry: AgentRegistry;
  let resolver: TrustResolver;

  beforeEach(() => {
    registry = AgentRegistry.fromAgents([
      agentFixture({ id: "luna" }),
      agentFixture({ id: "echo" }),
    ]);
    resolver = new TrustResolver(registry);
  });

  test("calls start → getPlatformUserId → register in order", async () => {
    const adapter = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const binding = new PresenceBinding("luna", adapter, resolver);

    await binding.startAndBind(noopMessageHandler());

    expect(adapter.calls).toEqual(["start", "getPlatformUserId"]);
    expect(binding.registeredPlatformId).toBe("1487100000000000001");
    expect(resolver.lookupAgentId("discord", "1487100000000000001")).toBe("luna");
  });

  test("registers under the constructor's agent id, not adapter.instanceId", async () => {
    const adapter = new FakeAdapter({
      platform: "discord",
      instanceId: "this-is-not-the-agent-id",
      platformUserId: "1487100000000000001",
    });
    const binding = new PresenceBinding("luna", adapter, resolver);

    await binding.startAndBind(noopMessageHandler());

    expect(resolver.lookupAgentId("discord", "1487100000000000001")).toBe("luna");
  });

  test("idempotent re-bind to the same platform user id is a no-op at the resolver", async () => {
    const adapter = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const binding = new PresenceBinding("luna", adapter, resolver);

    await binding.startAndBind(noopMessageHandler());
    // Second start of the SAME binding/adapter — TrustResolver.register is
    // idempotent for same-agent re-registration, so this must not throw.
    await binding.startAndBind(noopMessageHandler());

    expect(resolver.size).toBe(1);
    expect(resolver.lookupAgentId("discord", "1487100000000000001")).toBe("luna");
  });

  test("rejects when a different agent already owns the platform user id", async () => {
    const adapter1 = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const binding1 = new PresenceBinding("luna", adapter1, resolver);
    await binding1.startAndBind(noopMessageHandler());

    // Adapter2 has the SAME platform id but tries to bind as echo — identity-
    // theft attempt. The trust resolver rejects this; the binding rolls back
    // by stopping adapter2.
    const adapter2 = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const binding2 = new PresenceBinding("echo", adapter2, resolver);

    await expect(binding2.startAndBind(noopMessageHandler())).rejects.toThrow(
      PlatformIdAlreadyRegisteredError,
    );
    // Rollback: adapter2 was stopped despite the registration failure.
    expect(adapter2.calls).toEqual(["start", "getPlatformUserId", "stop"]);
    // The original luna mapping is untouched.
    expect(resolver.lookupAgentId("discord", "1487100000000000001")).toBe("luna");
  });
});

// =============================================================================
// startAndBind — failure paths
// =============================================================================

describe("PresenceBinding.startAndBind — failure paths", () => {
  let registry: AgentRegistry;
  let resolver: TrustResolver;

  beforeEach(() => {
    registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    resolver = new TrustResolver(registry);
  });

  test("adapter.start() failure → nothing registered, no rollback stop", async () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    adapter.startError = new Error("connect refused");
    const binding = new PresenceBinding("luna", adapter, resolver);

    await expect(binding.startAndBind(noopMessageHandler())).rejects.toThrow("connect refused");

    // start() failed before getPlatformUserId — so no rollback needed.
    expect(adapter.calls).toEqual(["start"]);
    expect(resolver.size).toBe(0);
    expect(binding.registeredPlatformId).toBeUndefined();
  });

  test("getPlatformUserId() failure → adapter is stopped, error is re-thrown", async () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    adapter.getPlatformUserIdError = new Error("client.user is null");
    const binding = new PresenceBinding("luna", adapter, resolver);

    await expect(binding.startAndBind(noopMessageHandler())).rejects.toThrow("client.user is null");

    // Rollback: start succeeded, getPlatformUserId failed, stop() ran.
    expect(adapter.calls).toEqual(["start", "getPlatformUserId", "stop"]);
    expect(resolver.size).toBe(0);
    expect(binding.registeredPlatformId).toBeUndefined();
  });

  test("register() failure on unknown agent → adapter is stopped, AgentNotFoundError re-thrown", async () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    // "ghost" is not in the registry, so trustResolver.register throws.
    const binding = new PresenceBinding("ghost", adapter, resolver);

    await expect(binding.startAndBind(noopMessageHandler())).rejects.toThrow(AgentNotFoundError);

    expect(adapter.calls).toEqual(["start", "getPlatformUserId", "stop"]);
    expect(resolver.size).toBe(0);
  });

  test("stop() failure during rollback is suppressed; original error wins", async () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    adapter.getPlatformUserIdError = new Error("primary failure");
    adapter.stopError = new Error("stop also exploded");
    const binding = new PresenceBinding("luna", adapter, resolver);

    // The "primary failure" is the actionable one — stop errors during
    // rollback would obscure it, so the binding swallows them.
    await expect(binding.startAndBind(noopMessageHandler())).rejects.toThrow("primary failure");
    expect(adapter.calls).toEqual(["start", "getPlatformUserId", "stop"]);
  });
});

// =============================================================================
// unbindAndStop
// =============================================================================

describe("PresenceBinding.unbindAndStop", () => {
  let registry: AgentRegistry;
  let resolver: TrustResolver;

  beforeEach(() => {
    registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    resolver = new TrustResolver(registry);
  });

  test("happy path: unregister then stop", async () => {
    const adapter = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const binding = new PresenceBinding("luna", adapter, resolver);
    await binding.startAndBind(noopMessageHandler());

    await binding.unbindAndStop();

    expect(adapter.calls).toEqual(["start", "getPlatformUserId", "stop"]);
    expect(resolver.size).toBe(0);
    expect(binding.registeredPlatformId).toBeUndefined();
  });

  test("idempotent — second unbind is a no-op", async () => {
    const adapter = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const binding = new PresenceBinding("luna", adapter, resolver);
    await binding.startAndBind(noopMessageHandler());
    await binding.unbindAndStop();
    // Reset call log to assert second-call behavior cleanly.
    adapter.calls.length = 0;

    await binding.unbindAndStop();

    // No platform id is registered anymore → no unregister call observable.
    // The adapter is stopped a second time — explicit, predictable behavior.
    expect(adapter.calls).toEqual(["stop"]);
  });

  test("safe to call when startAndBind was never called", async () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    const binding = new PresenceBinding("luna", adapter, resolver);

    await binding.unbindAndStop();

    expect(adapter.calls).toEqual(["stop"]);
    expect(resolver.size).toBe(0);
  });

  test("after rollback in startAndBind, unbindAndStop is still safe", async () => {
    const adapter = new FakeAdapter({ platform: "discord" });
    adapter.getPlatformUserIdError = new Error("client.user is null");
    const binding = new PresenceBinding("luna", adapter, resolver);
    await expect(binding.startAndBind(noopMessageHandler())).rejects.toThrow();

    // Rollback already stopped the adapter and never registered. Calling
    // unbindAndStop after that should not double-unregister or double-throw.
    await binding.unbindAndStop();

    // Second stop call (after rollback's first one) — the adapter records
    // both, but the binding doesn't throw on the predictable second stop.
    expect(adapter.calls).toEqual(["start", "getPlatformUserId", "stop", "stop"]);
  });
});

// =============================================================================
// Multi-platform per agent
// =============================================================================

describe("PresenceBinding — multi-platform per agent", () => {
  test("an agent with discord + mattermost gets two bindings; both register", async () => {
    const registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    const resolver = new TrustResolver(registry);

    const discordAdapter = new FakeAdapter({
      platform: "discord",
      platformUserId: "1487100000000000001",
    });
    const mattermostAdapter = new FakeAdapter({
      platform: "mattermost",
      platformUserId: "luna-mm-userid-abc123",
    });

    const discordBinding = new PresenceBinding("luna", discordAdapter, resolver);
    const mattermostBinding = new PresenceBinding("luna", mattermostAdapter, resolver);

    await discordBinding.startAndBind(noopMessageHandler());
    await mattermostBinding.startAndBind(noopMessageHandler());

    expect(resolver.size).toBe(2);
    expect(resolver.identitiesOf("luna")).toEqual([
      { platform: "discord", platformId: "1487100000000000001" },
      { platform: "mattermost", platformId: "luna-mm-userid-abc123" },
    ]);

    await discordBinding.unbindAndStop();
    expect(resolver.size).toBe(1);
    expect(resolver.lookupAgentId("mattermost", "luna-mm-userid-abc123")).toBe("luna");

    await mattermostBinding.unbindAndStop();
    expect(resolver.size).toBe(0);
  });
});

// =============================================================================
// Module shape
// =============================================================================

describe("Module shape", () => {
  test("exports PresenceBinding + UnsupportedPlatformError", () => {
    expect(typeof PresenceBinding).toBe("function");
    expect(typeof UnsupportedPlatformError).toBe("function");
  });

  test("known-platforms list matches the TrustResolver.Platform union (drift guard)", () => {
    // Compile-time exhaustiveness comes from the `satisfies Record<Platform, true>`
    // bound on KNOWN_PLATFORMS in presence-binding.ts. This runtime check is the
    // belt-and-suspenders: build a sample agent with each Platform variant in
    // turn (via the FakeAdapter) and confirm the binding accepts it. If a new
    // Platform variant is added to the union without updating KNOWN_PLATFORMS,
    // the compile-time check fails first; if KNOWN_PLATFORMS is updated but the
    // adapter wiring isn't, this runtime check stays green but the missing
    // adapter-side wiring will surface in 7.2c-{platform} implementation work.
    const registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    const resolver = new TrustResolver(registry);
    const platforms: Platform[] = ["discord", "mattermost"];
    for (const platform of platforms) {
      const adapter = new FakeAdapter({ platform });
      expect(() => new PresenceBinding("luna", adapter, resolver)).not.toThrow();
    }
  });
});
