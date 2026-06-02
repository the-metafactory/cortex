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
import { SurfaceGateway } from "../surface-gateway";
import type { GatewayAdapterFactory } from "../gateway-adapters";
import type { PlatformAdapter } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import type { MyelinRuntime } from "../../bus/myelin/runtime";

// =============================================================================
// Fakes
// =============================================================================

const RUNTIME_STUB = {
  publish: async () => {},
  onEnvelope: () => () => {},
  stop: async () => {},
} as unknown as MyelinRuntime;

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
      factory,
    });
    expect(gw).toBeInstanceOf(SurfaceGateway);
    // one adapter constructed for the one discord binding
    expect(constructed).toEqual(["discord:111222333444555666"]);
    // gw.start() was awaited → the adapter's start() ran
    expect(started).toEqual(["discord:111222333444555666"]);
  });

  test("flag on but surfaces undefined → returns undefined (graceful degrade)", async () => {
    const started: string[] = [];
    const { factory, constructed } = makeCountingFactory(started);
    const gw = await startGatewayIfEnabled({
      env: { CORTEX_GATEWAY: "1" },
      surfaces: undefined,
      principal: "andreas",
      runtime: RUNTIME_STUB,
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
      factory,
    });
    expect(gw).toBeInstanceOf(SurfaceGateway);
    // stop() resolves without throwing
    await gw?.stop();
  });
});
