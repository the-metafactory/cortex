/**
 * GW.a.3b.1 — gateway-bootstrap tests (cortex#524, TDD Red→Green).
 *
 * Tests cover:
 *
 *   1.  isGatewayEnabled — CORTEX_GATEWAY unset → false
 *   2.  isGatewayEnabled — CORTEX_GATEWAY="1" → true
 *   3.  isGatewayEnabled — CORTEX_GATEWAY="0" → false
 *   4.  isGatewayEnabled — CORTEX_GATEWAY="true" → false (only "1" is truthy)
 *   5.  maybeCreateSurfaceGateway — enabled=false → undefined (flag off)
 *   6.  maybeCreateSurfaceGateway — enabled=true, surfaces=undefined → undefined + logged
 *   7.  maybeCreateSurfaceGateway — enabled=true, surfaces={} (no bindings) → undefined + logged
 *   8.  maybeCreateSurfaceGateway — enabled=true, valid discord surfaces → SurfaceGateway instance
 *   9.  maybeCreateSurfaceGateway — valid discord surfaces, injected adapters forwarded to instance
 *  10.  maybeCreateSurfaceGateway — onUnroutable forwarded to SurfaceGateway options
 *  11.  maybeCreateSurfaceGateway — enabled=true, surfaces with slack binding → SurfaceGateway instance
 *  12.  maybeCreateSurfaceGateway — enabled=true, surfaces with mattermost binding → SurfaceGateway instance
 *  13.  maybeCreateSurfaceGateway — buildBindingIndex throws (duplicate key) → propagates error
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  isGatewayEnabled,
  isGatewayPublishEnabled,
  maybeCreateSurfaceGateway,
  type GatewayBootstrapOpts,
} from "../gateway-bootstrap";
import {
  SurfaceGateway,
  LoggingInboundSink,
  type GatewayInboundSink,
  type GatewayInboundDecision,
} from "../surface-gateway";
import type { PlatformAdapter, InboundMessage } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import { testRegistryWithWeb } from "./test-registry-support";

// =============================================================================
// Minimal fake PlatformAdapter (no real platform connection needed)
// =============================================================================

function makeFakeAdapter(instanceId = "fake-adapter-1"): PlatformAdapter {
  return {
    platform: "discord",
    instanceId,
    start: async () => {},
    stop: async () => {},
    getPlatformUserId: async () => "bot-user-id",
    fetchContext: async () => [],
    resolveAccess: () => ({
      allowed: true,
      features: { chat: true, async: false, team: false },
    }),
    postResponse: async () => {},
    sendTyping: async () => {},
    sendProgress: async () => {},
    clearProgress: async () => {},
    createThread: async () => ({
      instanceId,
      channelId: "ch-new-thread",
    }),
    resolveLogicalTarget: async () => null,
    notifyPrincipal: async () => {},
  };
}

// =============================================================================
// Surfaces fixtures
// =============================================================================

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

const MATTERMOST_SURFACES: Surfaces = {
  mattermost: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-api-token-xyz",
      },
    },
  ],
};

/** Empty Surfaces object — all arrays absent; zero bindings across all platforms. */
const EMPTY_SURFACES: Surfaces = {};

// =============================================================================
// isGatewayEnabled
// =============================================================================

describe("isGatewayEnabled", () => {
  test("returns false when CORTEX_GATEWAY is unset", () => {
    expect(isGatewayEnabled({})).toBe(false);
  });

  test("returns true when CORTEX_GATEWAY is '1'", () => {
    expect(isGatewayEnabled({ CORTEX_GATEWAY: "1" })).toBe(true);
  });

  test("returns false when CORTEX_GATEWAY is '0'", () => {
    expect(isGatewayEnabled({ CORTEX_GATEWAY: "0" })).toBe(false);
  });

  test("returns false when CORTEX_GATEWAY is 'true' (only '1' is truthy)", () => {
    expect(isGatewayEnabled({ CORTEX_GATEWAY: "true" })).toBe(false);
  });

  test("returns false when CORTEX_GATEWAY is undefined in the env record", () => {
    expect(isGatewayEnabled({ CORTEX_GATEWAY: undefined })).toBe(false);
  });
});

// =============================================================================
// isGatewayPublishEnabled — the second, independent opt-in gate
// =============================================================================

describe("isGatewayPublishEnabled", () => {
  test("returns false when CORTEX_GATEWAY_PUBLISH is unset", () => {
    expect(isGatewayPublishEnabled({})).toBe(false);
  });

  test("returns true when CORTEX_GATEWAY_PUBLISH is '1'", () => {
    expect(isGatewayPublishEnabled({ CORTEX_GATEWAY_PUBLISH: "1" })).toBe(true);
  });

  test("returns false when CORTEX_GATEWAY_PUBLISH is '0'", () => {
    expect(isGatewayPublishEnabled({ CORTEX_GATEWAY_PUBLISH: "0" })).toBe(false);
  });

  test("returns false when CORTEX_GATEWAY_PUBLISH is 'true' (only '1' is truthy)", () => {
    expect(isGatewayPublishEnabled({ CORTEX_GATEWAY_PUBLISH: "true" })).toBe(false);
  });

  test("returns false when CORTEX_GATEWAY_PUBLISH is undefined in the env record", () => {
    expect(isGatewayPublishEnabled({ CORTEX_GATEWAY_PUBLISH: undefined })).toBe(false);
  });

  test("is independent of CORTEX_GATEWAY (reads only its own key)", () => {
    // The two flags are orthogonal at the read layer; the AND is composed by
    // the caller (startGatewayIfEnabled). isGatewayPublishEnabled ignores
    // CORTEX_GATEWAY entirely.
    expect(isGatewayPublishEnabled({ CORTEX_GATEWAY: "1" })).toBe(false);
    expect(
      isGatewayPublishEnabled({ CORTEX_GATEWAY: "0", CORTEX_GATEWAY_PUBLISH: "1" }),
    ).toBe(true);
  });
});

// =============================================================================
// maybeCreateSurfaceGateway — flag-off path
// =============================================================================

describe("maybeCreateSurfaceGateway — enabled=false", () => {
  test("returns undefined immediately when enabled is false", () => {
    const opts: GatewayBootstrapOpts = {
      enabled: false,
      surfaces: DISCORD_SURFACES,
      adapters: [makeFakeAdapter()],
    };
    const result = maybeCreateSurfaceGateway(opts);
    expect(result).toBeUndefined();
  });

  test("returns undefined without logging when enabled is false (no stderr output)", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const opts: GatewayBootstrapOpts = {
        enabled: false,
        surfaces: DISCORD_SURFACES,
        adapters: [makeFakeAdapter()],
      };
      maybeCreateSurfaceGateway(opts);
      // No stderr call expected for the flag-off path
      const gatewayCalls = stderrSpy.mock.calls.filter((args) =>
        String(args[0]).includes("gateway"),
      );
      expect(gatewayCalls.length).toBe(0);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// =============================================================================
// maybeCreateSurfaceGateway — surfaces absent / empty
// =============================================================================

describe("maybeCreateSurfaceGateway — no bindings", () => {
  test("returns undefined when surfaces is undefined, logs to stderr", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const opts: GatewayBootstrapOpts = {
        enabled: true,
        surfaces: undefined,
        adapters: [makeFakeAdapter()],
      };
      const result = maybeCreateSurfaceGateway(opts);
      expect(result).toBeUndefined();
      const logged = stderrSpy.mock.calls.some((args) =>
        String(args[0]).includes("CORTEX_GATEWAY"),
      );
      expect(logged).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("returns undefined when surfaces is empty object, logs to stderr", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const opts: GatewayBootstrapOpts = {
        enabled: true,
        surfaces: EMPTY_SURFACES,
        adapters: [makeFakeAdapter()],
      };
      const result = maybeCreateSurfaceGateway(opts);
      expect(result).toBeUndefined();
      const logged = stderrSpy.mock.calls.some((args) =>
        String(args[0]).includes("CORTEX_GATEWAY"),
      );
      expect(logged).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test("stderr message mentions 'no surfaces bindings found' when surfaces empty", () => {
    const messages: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });
    try {
      maybeCreateSurfaceGateway({
        enabled: true,
        surfaces: EMPTY_SURFACES,
        adapters: [makeFakeAdapter()],
      });
      const combined = messages.join("");
      expect(combined).toContain("no surfaces bindings found");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// =============================================================================
// maybeCreateSurfaceGateway — happy path (returns SurfaceGateway)
// =============================================================================

describe("maybeCreateSurfaceGateway — happy path", () => {
  test("returns a SurfaceGateway instance when discord surfaces provided", () => {
    const result = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: DISCORD_SURFACES,
      adapters: [makeFakeAdapter()],
    });
    expect(result).toBeInstanceOf(SurfaceGateway);
  });

  test("returns a SurfaceGateway instance when slack surfaces provided", () => {
    const result = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: SLACK_SURFACES,
      adapters: [makeFakeAdapter("fake-slack-1")],
    });
    expect(result).toBeInstanceOf(SurfaceGateway);
  });

  test("returns a SurfaceGateway instance when mattermost surfaces provided", () => {
    const result = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: MATTERMOST_SURFACES,
      adapters: [makeFakeAdapter("fake-mm-1")],
    });
    expect(result).toBeInstanceOf(SurfaceGateway);
  });

  test("the returned gateway can start and stop the injected adapters", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const fakeAdapter = makeFakeAdapter("injected-adapter");
    fakeAdapter.start = async (onMsg) => {
      started.push(fakeAdapter.instanceId);
    };
    fakeAdapter.stop = async () => {
      stopped.push(fakeAdapter.instanceId);
    };

    const gw = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: DISCORD_SURFACES,
      adapters: [fakeAdapter],
    });
    expect(gw).toBeInstanceOf(SurfaceGateway);
    await gw!.start();
    expect(started).toEqual(["injected-adapter"]);
    await gw!.stop();
    expect(stopped).toEqual(["injected-adapter"]);
  });

  test("onUnroutable callback is forwarded to the SurfaceGateway", async () => {
    const unroutableCalls: { msg: InboundMessage; reason: string }[] = [];

    const gw = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: DISCORD_SURFACES,
      adapters: [makeFakeAdapter()],
      onUnroutable: (msg, reason) => {
        unroutableCalls.push({ msg, reason });
      },
    });

    expect(gw).toBeInstanceOf(SurfaceGateway);

    // Trigger handleInbound with a message that won't route (wrong guildId)
    const fakeAdapter = makeFakeAdapter();
    const dmMsg: InboundMessage = {
      platform: "discord",
      instanceId: "discord-luna-mf",
      authorId: "user-1",
      authorName: "Test User",
      content: "hello",
      channelId: "ch-dm",
      attachments: [],
      timestamp: new Date(),
      // No guildId → DM → unroutable
    };
    await gw!.handleInbound(fakeAdapter, dmMsg);
    expect(unroutableCalls.length).toBe(1);
  });

  test("logs a one-line SHADOW summary to stdout on construction", () => {
    const messages: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });
    try {
      maybeCreateSurfaceGateway({
        enabled: true,
        surfaces: DISCORD_SURFACES,
        adapters: [makeFakeAdapter()],
      });
      const combined = messages.join("");
      expect(combined).toContain("SHADOW");
      expect(combined).toContain("LoggingInboundSink");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("summary log includes binding count and adapter count", () => {
    const messages: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });
    try {
      maybeCreateSurfaceGateway({
        enabled: true,
        surfaces: DISCORD_SURFACES,
        adapters: [makeFakeAdapter("a1"), makeFakeAdapter("a2")],
      });
      const combined = messages.join("");
      // 1 discord binding → "1 binding"
      expect(combined).toMatch(/1\s+binding/);
      // 2 adapters
      expect(combined).toMatch(/2\s+adapter/);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// =============================================================================
// maybeCreateSurfaceGateway — sink injection (shadow default, live override)
// =============================================================================

describe("maybeCreateSurfaceGateway — sink injection", () => {
  test("defaults to LoggingInboundSink when no sink is injected", () => {
    const gw = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: DISCORD_SURFACES,
      adapters: [makeFakeAdapter()],
    });
    expect(gw).toBeInstanceOf(SurfaceGateway);
    expect(gw!.inboundSink).toBeInstanceOf(LoggingInboundSink);
  });

  test("uses the injected sink when one is provided", () => {
    // A minimal custom sink (not a LoggingInboundSink) — proves the factory
    // honours the injection rather than always constructing its own default.
    const calls: GatewayInboundDecision[] = [];
    const customSink: GatewayInboundSink = {
      publish: async (decision: GatewayInboundDecision) => {
        calls.push(decision);
      },
    };

    const gw = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: DISCORD_SURFACES,
      adapters: [makeFakeAdapter()],
      sink: customSink,
    });
    expect(gw).toBeInstanceOf(SurfaceGateway);
    // identity check — exactly the injected instance, not a default
    expect(gw!.inboundSink).toBe(customSink);
    expect(gw!.inboundSink).not.toBeInstanceOf(LoggingInboundSink);
  });

  test("logs LIVE + BusInboundSink wording when a non-logging sink is injected", () => {
    const messages: string[] = [];
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((msg) => {
      messages.push(String(msg));
      return true;
    });
    try {
      const customSink: GatewayInboundSink = {
        publish: async () => {},
      };
      maybeCreateSurfaceGateway({
        enabled: true,
        surfaces: DISCORD_SURFACES,
        adapters: [makeFakeAdapter()],
        sink: customSink,
      });
      const combined = messages.join("");
      expect(combined).toContain("LIVE");
      expect(combined).toContain("BusInboundSink");
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// =============================================================================
// maybeCreateSurfaceGateway — error propagation
// =============================================================================

describe("maybeCreateSurfaceGateway — error propagation", () => {
  test("propagates Error from buildBindingIndex (duplicate demux key)", () => {
    const duplicateDiscord: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: {
            token: "tok-1",
            guildId: "SAME_GUILD",
            agentChannelId: "aaa000000000000001",
            logChannelId: "bbb000000000000002",
          },
        },
        {
          agent: "sage",
          stack: "andreas/work",
          binding: {
            token: "tok-2",
            guildId: "SAME_GUILD", // duplicate — buildBindingIndex throws
            agentChannelId: "ccc000000000000003",
            logChannelId: "ddd000000000000004",
          },
        },
      ],
    };

    expect(() =>
      maybeCreateSurfaceGateway({
        enabled: true,
        surfaces: duplicateDiscord,
        adapters: [makeFakeAdapter()],
      }),
    ).toThrow(/ambiguous discord config/);
  });
});

// =============================================================================
// maybeCreateSurfaceGateway — web surfaces (C-110 / WEB-1 gateway routing fix)
//
// WEB-1 added the web adapter but `countBindings` previously excluded
// `surfaces.web`, so a web-only stack reported "0 bindings" and the gateway
// never started. This block pins the corrected path.
// =============================================================================

/** Web-only surfaces — one binding, instanceId "acme". */
const WEB_SURFACES: Surfaces = {
  web: [
    {
      agent: "pylon",
      stack: "andreas/acme",
      binding: {
        host: "127.0.0.1",
        instanceId: "acme",
        port: 8090,
        broadcastUrl: "http://localhost:9090/broadcast",
        transport: "ws",
        authScheme: "cf-access",
      },
    },
  ],
};

describe("maybeCreateSurfaceGateway — web surfaces", () => {
  test("returns a SurfaceGateway when web-only surfaces provided (countBindings counts web)", () => {
    const result = maybeCreateSurfaceGateway({
      enabled: true,
      surfaces: WEB_SURFACES,
      adapters: [makeFakeAdapter("fake-web-1")],
      registry: testRegistryWithWeb(),
    });
    expect(result).toBeInstanceOf(SurfaceGateway);
  });

  test("does NOT return undefined or log a no-bindings warning for web-only surfaces", () => {
    const messages: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((m) => {
      messages.push(String(m));
      return true;
    });
    try {
      const result = maybeCreateSurfaceGateway({
        enabled: true,
        surfaces: WEB_SURFACES,
        adapters: [makeFakeAdapter("fake-web-2")],
        registry: testRegistryWithWeb(),
      });
      // Must have created the gateway, not hit the "no bindings" early-exit
      expect(result).toBeInstanceOf(SurfaceGateway);
      // No "no surfaces bindings found" warning
      const warned = messages.some((m) => m.includes("no surfaces bindings found"));
      expect(warned).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
