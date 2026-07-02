/**
 * GW.a.3b.2b — gateway-adapters tests (cortex#524, TDD Red→Green).
 *
 * `buildGatewayAdapters` constructs ONE {@link PlatformAdapter} per surface
 * binding from the binding's credentials + injected deps. These tests use an
 * INJECTED factory so adapters are CONSTRUCTED, never started/connected — no
 * live tokens, no network. They assert:
 *
 *   1. one adapter per binding, across discord/slack/mattermost
 *   2. the right platform + the binding credentials reach the factory
 *   3. the gateway source identity `{principal}.gateway.{instance}` is built
 *      and the interim instance id (`{platform}:{demuxKey}`) is threaded
 *   4. zero bindings → zero adapters
 *   5. deps.runtime / deps.systemEventSource are forwarded verbatim
 */

import { describe, expect, test } from "bun:test";
import {
  buildGatewayAdapters,
  type GatewayAdapterDeps,
  type GatewayAdapterFactory,
} from "../gateway-adapters";
import type { PlatformAdapter, InboundMessage } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import type { SystemEventSource } from "../../bus/system-events";
import type { MyelinRuntime } from "../../bus/myelin/runtime";

// =============================================================================
// Recording fake factory — construct-only, captures every call's args
// =============================================================================

interface FactoryCall {
  platform: "discord" | "slack" | "mattermost" | "web";
  instanceId: string;
  source: SystemEventSource;
  /** The credential block handed to the factory (presence-shaped). */
  binding: Record<string, unknown>;
  runtime: MyelinRuntime | undefined;
  allowedGuildIds?: string[];
  presenceByGuildId?: Record<string, { agentChannelId: string; logChannelId: string }>;
}

function makeFakeAdapter(
  platform: "discord" | "slack" | "mattermost" | "web",
  instanceId: string,
): PlatformAdapter {
  return {
    platform,
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
    createThread: async () => ({ instanceId, channelId: "ch" }),
    resolveLogicalTarget: async () => null,
    notifyPrincipal: async () => {},
  };
}

function makeRecordingFactory(): {
  factory: GatewayAdapterFactory;
  calls: FactoryCall[];
} {
  const calls: FactoryCall[] = [];
  const factory: GatewayAdapterFactory = {
    discord: (args) => {
      const presenceByGuildId = Object.fromEntries(
        [...args.presenceByGuildId].map(([guildId, presence]) => [
          guildId,
          {
            agentChannelId: presence.agentChannelId,
            logChannelId: presence.logChannelId,
          },
        ]),
      );
      calls.push({
        platform: "discord",
        instanceId: args.instanceId,
        source: args.source,
        binding: args.binding,
        runtime: args.runtime,
        allowedGuildIds: [...args.allowedGuildIds].sort(),
        presenceByGuildId,
      });
      return makeFakeAdapter("discord", args.instanceId);
    },
    slack: (args) => {
      calls.push({
        platform: "slack",
        instanceId: args.instanceId,
        source: args.source,
        binding: args.binding,
        runtime: args.runtime,
      });
      return makeFakeAdapter("slack", args.instanceId);
    },
    mattermost: (args) => {
      calls.push({
        platform: "mattermost",
        instanceId: args.instanceId,
        source: args.source,
        binding: args.binding,
        runtime: args.runtime,
      });
      return makeFakeAdapter("mattermost", args.instanceId);
    },
    web: (args) => {
      calls.push({
        platform: "web",
        instanceId: args.instanceId,
        source: args.source,
        binding: args.binding,
        runtime: args.runtime,
      });
      return makeFakeAdapter("web", args.instanceId);
    },
  };
  return { factory, calls };
}

// =============================================================================
// Fixtures
// =============================================================================

const RUNTIME_STUB = {
  publish: async () => {},
  onEnvelope: () => () => {},
  stop: async () => {},
} as unknown as MyelinRuntime;

function makeDeps(factory: GatewayAdapterFactory): GatewayAdapterDeps {
  return {
    principal: "andreas",
    runtime: RUNTIME_STUB,
    factory,
  };
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

const SAME_TOKEN_DISCORD_SURFACES: Surfaces = {
  discord: [
    {
      agent: "juniper",
      stack: "jc/default",
      binding: {
        token: "tok-juniper",
        guildId: "1487023327791808592",
        agentChannelId: "1487023328324616266",
        logChannelId: "1487023328324616266",
      },
    },
    {
      agent: "juniper",
      stack: "jc/default",
      binding: {
        token: "tok-juniper",
        guildId: "555666777888999000",
        agentChannelId: "1513296336739635322",
        logChannelId: "1513296336739635322",
      },
    },
  ],
};

const SAME_TOKEN_DIFFERENT_STACKS_DISCORD_SURFACES: Surfaces = {
  discord: [
    {
      agent: "juniper",
      stack: "jc/default",
      binding: {
        token: "tok-juniper",
        guildId: "1487023327791808592",
        agentChannelId: "1487023328324616266",
        logChannelId: "1487023328324616266",
      },
    },
    {
      agent: "juniper",
      stack: "jc/research",
      binding: {
        token: "tok-juniper",
        guildId: "555666777888999000",
        agentChannelId: "1513296336739635322",
        logChannelId: "1513296336739635322",
      },
    },
  ],
};

const MULTI_SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        token: "tok-luna",
        guildId: "G-LUNA",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
  ],
  slack: [
    {
      agent: "sage",
      stack: "andreas/work",
      binding: {
        botToken: "xoxb-1-2-3",
        appToken: "xapp-1-2-3",
        workspaceId: "T0123456789",
      },
    },
  ],
  mattermost: [
    {
      agent: "echo",
      stack: "andreas/ops",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-tok",
      },
    },
  ],
};

// =============================================================================
// Tests
// =============================================================================

describe("buildGatewayAdapters", () => {
  test("zero bindings → zero adapters, factory never called", () => {
    const { factory, calls } = makeRecordingFactory();
    const adapters = buildGatewayAdapters({}, makeDeps(factory));
    expect(adapters).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test("one discord binding → one discord adapter", () => {
    const { factory, calls } = makeRecordingFactory();
    const adapters = buildGatewayAdapters(DISCORD_SURFACES, makeDeps(factory));
    expect(adapters.length).toBe(1);
    expect(adapters[0]?.platform).toBe("discord");
    expect(calls.length).toBe(1);
    expect(calls[0]?.platform).toBe("discord");
  });

  test("discord binding forwards the credential block verbatim", () => {
    const { factory, calls } = makeRecordingFactory();
    buildGatewayAdapters(DISCORD_SURFACES, makeDeps(factory));
    const call = calls[0];
    expect(call?.binding.token).toBe("tok-luna-discord");
    expect(call?.binding.guildId).toBe("111222333444555666");
    expect(call?.binding.agentChannelId).toBe("aaa000000000000001");
    expect(call?.binding.logChannelId).toBe("bbb000000000000002");
  });

  test("source identity is {principal}.gateway.{instance} with the interim instance id", () => {
    const { factory, calls } = makeRecordingFactory();
    buildGatewayAdapters(DISCORD_SURFACES, makeDeps(factory));
    const src = calls[0]?.source;
    expect(src?.principal).toBe("andreas");
    expect(src?.agent).toBe("gateway");
    // interim instance id = `{platform}:{demuxKey}` (= guildId for discord)
    expect(src?.instance).toBe("discord:111222333444555666");
  });

  test("instanceId threaded to the factory matches the interim instance id", () => {
    const { factory, calls } = makeRecordingFactory();
    buildGatewayAdapters(DISCORD_SURFACES, makeDeps(factory));
    expect(calls[0]?.instanceId).toBe("discord:111222333444555666");
  });

  test("runtime is forwarded verbatim to the factory", () => {
    const { factory, calls } = makeRecordingFactory();
    buildGatewayAdapters(DISCORD_SURFACES, makeDeps(factory));
    expect(calls[0]?.runtime).toBe(RUNTIME_STUB);
  });

  test("same Discord token across two guild bindings → one adapter with both guilds allowed", () => {
    const { factory, calls } = makeRecordingFactory();
    const adapters = buildGatewayAdapters(SAME_TOKEN_DISCORD_SURFACES, makeDeps(factory));

    expect(adapters.length).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]?.platform).toBe("discord");
    expect(calls[0]?.instanceId).toMatch(/^discord:token:[0-9a-f]{12}$/);
    expect(calls[0]?.allowedGuildIds).toEqual([
      "1487023327791808592",
      "555666777888999000",
    ]);
    expect(calls[0]?.presenceByGuildId).toEqual({
      "1487023327791808592": {
        agentChannelId: "1487023328324616266",
        logChannelId: "1487023328324616266",
      },
      "555666777888999000": {
        agentChannelId: "1513296336739635322",
        logChannelId: "1513296336739635322",
      },
    });
  });

  test("same Discord token across two stacks → separate stack-scoped adapters", () => {
    const { factory, calls } = makeRecordingFactory();
    const adapters = buildGatewayAdapters(
      SAME_TOKEN_DIFFERENT_STACKS_DISCORD_SURFACES,
      makeDeps(factory),
    );

    expect(adapters.length).toBe(2);
    expect(calls.map((call) => call.instanceId)).toEqual([
      "discord:1487023327791808592",
      "discord:555666777888999000",
    ]);
    expect(calls.map((call) => call.allowedGuildIds)).toEqual([
      ["1487023327791808592"],
      ["555666777888999000"],
    ]);
  });

  test("mixed surfaces → one adapter per binding, correct platforms", () => {
    const { factory, calls } = makeRecordingFactory();
    const adapters = buildGatewayAdapters(MULTI_SURFACES, makeDeps(factory));
    expect(adapters.length).toBe(3);
    const platforms = adapters.map((a) => a.platform).sort();
    expect(platforms).toEqual(["discord", "mattermost", "slack"]);
    const callPlatforms = calls.map((c) => c.platform).sort();
    expect(callPlatforms).toEqual(["discord", "mattermost", "slack"]);
  });

  test("slack source instance is slack:{workspaceId}", () => {
    const { factory, calls } = makeRecordingFactory();
    buildGatewayAdapters(MULTI_SURFACES, makeDeps(factory));
    const slackCall = calls.find((c) => c.platform === "slack");
    expect(slackCall?.source.instance).toBe("slack:T0123456789");
    expect(slackCall?.binding.botToken).toBe("xoxb-1-2-3");
    expect(slackCall?.binding.appToken).toBe("xapp-1-2-3");
  });

  test("mattermost source instance is mattermost:{apiUrl}", () => {
    const { factory, calls } = makeRecordingFactory();
    buildGatewayAdapters(MULTI_SURFACES, makeDeps(factory));
    const mmCall = calls.find((c) => c.platform === "mattermost");
    expect(mmCall?.source.instance).toBe("mattermost:https://mm.example.com");
    expect(mmCall?.binding.apiUrl).toBe("https://mm.example.com");
    expect(mmCall?.binding.apiToken).toBe("mm-tok");
  });

  test("constructed adapters are never started by the builder", async () => {
    // Build with a factory whose adapters record start() calls; the builder
    // must NOT call start() — start is the gateway's job at gw.start().
    const started: string[] = [];
    const factory: GatewayAdapterFactory = {
      discord: (args) => {
        const a = makeFakeAdapter("discord", args.instanceId);
        a.start = async () => {
          started.push(args.instanceId);
        };
        return a;
      },
      slack: (args) => makeFakeAdapter("slack", args.instanceId),
      mattermost: (args) => makeFakeAdapter("mattermost", args.instanceId),
      web: (args) => makeFakeAdapter("web", args.instanceId),
    };
    buildGatewayAdapters(DISCORD_SURFACES, {
      principal: "andreas",
      runtime: RUNTIME_STUB,
      factory,
    });
    // builder is synchronous + construct-only
    expect(started).toEqual([]);
    // sanity: the message type import is exercised (no-op assertion)
    const _msgType: InboundMessage | undefined = undefined;
    expect(_msgType).toBeUndefined();
  });
});

// =============================================================================
// cortex#1209 belt-and-suspenders — a binding token that is STILL an
// unresolved `__ENV__` placeholder at adapter-construction is a fail-fast, so
// no path can ever hand the literal `__X__` to `connect()`.
// =============================================================================
describe("buildGatewayAdapters — unresolved placeholder fail-fast (#1209)", () => {
  test("discord binding.token still __X__ → throws before the factory is called", () => {
    const { factory, calls } = makeRecordingFactory();
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "vega",
          stack: "andreas/research",
          binding: {
            token: "__VEGA_BOT_TOKEN__",
            guildId: "111222333444555666",
            agentChannelId: "aaa000000000000001",
            logChannelId: "bbb000000000000002",
          },
        },
      ],
    };
    expect(() => buildGatewayAdapters(surfaces, makeDeps(factory))).toThrow(/VEGA_BOT_TOKEN/);
    // fail-fast: the factory must never have been reached with the literal
    expect(calls.length).toBe(0);
  });

  test("mattermost binding.apiToken still __X__ → throws before the factory is called", () => {
    const { factory, calls } = makeRecordingFactory();
    const surfaces: Surfaces = {
      mattermost: [
        {
          agent: "echo",
          stack: "andreas/ops",
          binding: {
            apiUrl: "https://mm.example.com",
            apiToken: "__MM_API_TOKEN__",
          },
        },
      ],
    };
    expect(() => buildGatewayAdapters(surfaces, makeDeps(factory))).toThrow(/MM_API_TOKEN/);
    expect(calls.length).toBe(0);
  });

  test("resolved (inline) tokens pass the guard and construct normally", () => {
    const { factory, calls } = makeRecordingFactory();
    const adapters = buildGatewayAdapters(DISCORD_SURFACES, makeDeps(factory));
    expect(adapters.length).toBe(1);
    expect(calls.length).toBe(1);
  });
});
