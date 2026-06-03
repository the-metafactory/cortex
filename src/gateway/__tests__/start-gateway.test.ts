/**
 * GW.a.3b.2b — start-gateway tests (cortex#524, TDD Red→Green).
 *
 * `startGatewayIfEnabled` is the flag-on orchestration that keeps cortex.ts
 * thin. These tests assert the HARD SAFETY CONTRACT:
 *
 *   - flag OFF → returns undefined, constructs NOTHING (the injected adapter
 *     factory is NEVER called — proves the flag-off path is a true no-op).
 *   - flag ON + surfaces → builds N adapters, constructs a SurfaceGateway,
 *     calls gw.start(), returns the started gateway (injected fakes only —
 *     no live connection is faked).
 *   - flag ON + no surfaces → returns undefined (degrade gracefully).
 */

import { describe, expect, test } from "bun:test";
import { startGatewayIfEnabled } from "../start-gateway";
import { SurfaceGateway, LoggingInboundSink } from "../surface-gateway";
import { BusInboundSink } from "../bus-inbound-sink";
import type { GatewayAdapterFactory } from "../gateway-adapters";
import type { PlatformAdapter } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SystemEventSource } from "../../bus/system-events";
import type { PolicyEngine } from "../../common/policy/engine";

// =============================================================================
// Fakes
// =============================================================================

const RUNTIME_STUB = {
  publish: async () => {},
  onEnvelope: () => () => {},
  stop: async () => {},
} as unknown as MyelinRuntime;

// Live-sink deps. They only need to be present (non-undefined) for the
// BusInboundSink to be constructed; these tests assert the SELECTED SINK TYPE,
// not a real publish (BusInboundSink publish behaviour is covered in
// bus-inbound-sink.test.ts).
const SOURCE_STUB = {
  scope: "local",
  principal: "andreas",
  instance: "gateway-1",
} as unknown as SystemEventSource;

const POLICY_ENGINE_STUB = {
  resolve: () => undefined,
} as unknown as PolicyEngine;

function makeFakeAdapter(
  platform: "discord" | "slack" | "mattermost",
  instanceId: string,
  onStart?: () => void,
): PlatformAdapter {
  return {
    platform,
    instanceId,
    start: async () => {
      onStart?.();
    },
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
    createThread: async () => ({ instanceId, channelId: "ch" }),
    resolveLogicalTarget: async () => null,
    notifyPrincipal: async () => {},
  };
}

/** A factory + a record of how many times it was invoked. */
function makeCountingFactory(started: string[]): {
  factory: GatewayAdapterFactory;
  constructed: string[];
} {
  const constructed: string[] = [];
  const factory: GatewayAdapterFactory = {
    discord: (args) => {
      constructed.push(args.instanceId);
      return makeFakeAdapter("discord", args.instanceId, () =>
        started.push(args.instanceId),
      );
    },
    slack: (args) => {
      constructed.push(args.instanceId);
      return makeFakeAdapter("slack", args.instanceId, () =>
        started.push(args.instanceId),
      );
    },
    mattermost: (args) => {
      constructed.push(args.instanceId);
      return makeFakeAdapter("mattermost", args.instanceId, () =>
        started.push(args.instanceId),
      );
    },
  };
  return { factory, constructed };
}

const DISCORD_SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        token: "tok-luna-discord",
        guildId: "111222333444555666",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
  ],
};

// =============================================================================
// Tests
// =============================================================================

describe("startGatewayIfEnabled — flag off", () => {
  test("CORTEX_GATEWAY unset → returns undefined, constructs NOTHING", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: {}, // flag unset
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw).toBeUndefined();
    // HARD CONTRACT: nothing constructed, nothing started.
    expect(constructed).toEqual([]);
    expect(started).toEqual([]);
  });

  test("CORTEX_GATEWAY='0' → returns undefined, constructs NOTHING", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "0" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw).toBeUndefined();
    expect(constructed).toEqual([]);
    expect(started).toEqual([]);
  });

  test("CORTEX_GATEWAY='true' → returns undefined (only '1' is truthy)", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "true" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw).toBeUndefined();
    expect(constructed).toEqual([]);
  });
});

describe("startGatewayIfEnabled — flag on", () => {
  test("flag on + surfaces → builds adapters, returns a started SurfaceGateway", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway).toBeInstanceOf(SurfaceGateway);
    // one adapter constructed for the one discord binding
    expect(constructed).toEqual(["discord:111222333444555666"]);
    // gw.start() was awaited → the adapter's start() ran
    expect(started).toEqual(["discord:111222333444555666"]);
    // a.3d — the started gateway exposes its adapters + bound stacks so the
    // boot path can wire the OUTBOUND dispatch sink over them.
    expect(gw?.adapters.map((a) => a.instanceId)).toEqual([
      "discord:111222333444555666",
    ]);
    // the one binding's stack leaf (parsed from "andreas/meta-factory")
    expect(gw?.stacks).toEqual(["meta-factory"]);
  });

  test("multi-stack bindings → distinct bound stacks (a.3d outbound subjects)", async () => {
    const started: string[] = [];
    const { factory } = makeCountingFactory(started);
    const multiStack: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: {
            token: "tok-1",
            guildId: "111",
            agentChannelId: "aaa000000000000001",
            logChannelId: "bbb000000000000002",
          },
        },
        {
          agent: "ivy",
          stack: "andreas/research",
          binding: {
            token: "tok-2",
            guildId: "222",
            agentChannelId: "ccc000000000000003",
            logChannelId: "ddd000000000000004",
          },
        },
      ],
    };
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" },
      surfaces: multiStack,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway).toBeInstanceOf(SurfaceGateway);
    // both bound stacks surface, in binding order — the outbound sink builds
    // one lifecycle subscribe subject per entry so neither stack's replies are
    // dropped.
    expect(gw?.stacks).toEqual(["meta-factory", "research"]);
    expect(gw?.adapters.map((a) => a.instanceId)).toEqual([
      "discord:111",
      "discord:222",
    ]);
  });

  test("cross-principal binding → throws loudly at boot (single-principal v1)", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const crossPrincipal: Surfaces = {
      discord: [
        {
          agent: "luna",
          // principal "someone-else" ≠ gateway principal "andreas"
          stack: "someone-else/meta-factory",
          binding: {
            token: "tok",
            guildId: "111222333444555666",
            agentChannelId: "aaa000000000000001",
            logChannelId: "bbb000000000000002",
          },
        },
      ],
    };
    await expect(
      startGatewayIfEnabled({
        env: { CORTEX_GATEWAY: "1" },
        surfaces: crossPrincipal,
        principal: "andreas",
        runtime: RUNTIME_STUB,
        source: SOURCE_STUB,
        policyEngine: POLICY_ENGINE_STUB,
        factory,
      }),
    ).rejects.toThrow(/cross-principal/i);
    // Fails BEFORE building or starting any adapter.
    expect(constructed).toEqual([]);
    expect(started).toEqual([]);
  });

  test("flag on but surfaces undefined → returns undefined (graceful degrade)", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" },
      surfaces: undefined,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw).toBeUndefined();
    // no bindings → no adapters → no gateway
    expect(constructed).toEqual([]);
    expect(started).toEqual([]);
  });

  test("flag on but surfaces empty → returns undefined", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" },
      surfaces: {},
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw).toBeUndefined();
    expect(constructed).toEqual([]);
  });

  test("the returned gateway can be stopped", async () => {
    const started: string[] = [];
    const { factory } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway).toBeInstanceOf(SurfaceGateway);
    // stop() resolves without throwing
    await gw?.gateway.stop();
  });
});

// =============================================================================
// Sink selection — the CORTEX_GATEWAY_PUBLISH double-opt-in gate
// =============================================================================

describe("startGatewayIfEnabled — sink selection (CORTEX_GATEWAY_PUBLISH)", () => {
  test("publish flag OFF (gateway on) → gateway uses LoggingInboundSink (SHADOW)", async () => {
    const started: string[] = [];
    const { factory } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" }, // publish flag absent
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway).toBeInstanceOf(SurfaceGateway);
    // SHADOW: no bus publish. The gateway's sink is a LoggingInboundSink,
    // exactly as it is today.
    expect(gw?.gateway.inboundSink).toBeInstanceOf(LoggingInboundSink);
    expect(gw?.gateway.inboundSink).not.toBeInstanceOf(BusInboundSink);
  });

  test("publish flag '0' (gateway on) → still SHADOW (only '1' is truthy)", async () => {
    const started: string[] = [];
    const { factory } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1", CORTEX_GATEWAY_PUBLISH: "0" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway.inboundSink).toBeInstanceOf(LoggingInboundSink);
  });

  test("publish flag 'true' (gateway on) → still SHADOW (only '1' is truthy)", async () => {
    const started: string[] = [];
    const { factory } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1", CORTEX_GATEWAY_PUBLISH: "true" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway.inboundSink).toBeInstanceOf(LoggingInboundSink);
  });

  test("BOTH flags '1' → gateway uses BusInboundSink (LIVE — publishing)", async () => {
    const started: string[] = [];
    const { factory } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1", CORTEX_GATEWAY_PUBLISH: "1" },
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw?.gateway).toBeInstanceOf(SurfaceGateway);
    // LIVE: the double-opt-in flipped the gateway to the bus-publishing sink.
    expect(gw?.gateway.inboundSink).toBeInstanceOf(BusInboundSink);
  });

  test("publish flag '1' but gateway flag OFF → undefined (gateway gate still wins)", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY_PUBLISH: "1" }, // gateway flag absent
      surfaces: DISCORD_SURFACES,
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    // The publish flag alone does NOT enable the gateway — CORTEX_GATEWAY is the
    // primary gate. Nothing is constructed.
    expect(gw).toBeUndefined();
    expect(constructed).toEqual([]);
    expect(started).toEqual([]);
  });

  test("both flags '1' but no bindings → undefined, never reaches BusInboundSink", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1", CORTEX_GATEWAY_PUBLISH: "1" },
      surfaces: {}, // no bindings → Path-2 degrade, no publish
      principal: "andreas",
      runtime: RUNTIME_STUB,
      source: SOURCE_STUB,
      policyEngine: POLICY_ENGINE_STUB,
      factory,
    });
    expect(gw).toBeUndefined();
    expect(constructed).toEqual([]);
  });
});
