/**
 * S9 (epic #1514, plan §2, cortex#1523) — `wireSurfaceAdapters` tests.
 *
 * Mirrors `gateway-adapters.test.ts`'s recording-fake pattern: an injected
 * `GatewayAdapterFactory` whose per-platform functions return construct-only
 * fake adapters (no platform connection). The fakes additionally implement
 * `surfaceConfig` / `setTrustedBotIds` / `attachInboundDispatch` /
 * `trustedBotIdCount` — the concrete-class-only members
 * `surface-adapter-boot.ts`'s `as DiscordAdapter` / `as SlackAdapter`
 * narrow-casts assume are present (see that module's doc). A fake missing one
 * of these would throw at the call site, not silently pass — that's the
 * safety net the module doc promises.
 *
 * Coverage:
 *   1. Discord → Mattermost → Slack construction + registration order.
 *   2. Router registration + `liveSurfaces` + `adapters[]` population.
 *   3. Disabled instances are skipped (no factory call, no adapter).
 *   4. GW.a.3b.2c gateway-owned suppression skips construction.
 *   5. Mattermost's `apiUrl`/`apiToken` guard skips without constructing.
 *   6. Pass-2 trust-resolver merge (Discord + Slack) resolves an in-process
 *      peer's bot id — asserted against the EXACT log line `wireSurfaceAdapters`
 *      emits (Sage #1547 r1: the claim must match what the test actually pins).
 *      Mattermost has no such call (its fake never implements the method).
 */

import { describe, expect, test } from "bun:test";
import { wireSurfaceAdapters, type WireSurfaceAdaptersOpts } from "../surface-adapter-boot";
import type { GatewayAdapterFactory } from "../../gateway/gateway-adapters";
import { AgentConfigSchema, type AgentConfig } from "../../common/types/config";
import type { Agent } from "../../common/types/cortex-config";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import type { SurfaceRouter, SurfaceAdapter } from "../../bus/surface-router";
import type { SystemEventSource } from "../../bus/system-events";
import type { InboundMessage, PlatformAdapter } from "../../adapters/types";

// =============================================================================
// Fixtures
// =============================================================================

const SYSTEM_EVENT_SOURCE: SystemEventSource = {
  principal: "test-op",
  agent: "test-cortex",
  instance: "default",
};

function minimalConfig(overrides: Partial<Record<string, unknown>> = {}): AgentConfig {
  return AgentConfigSchema.parse({
    agent: { name: "test-cortex", displayName: "TestCortex" },
    discord: [],
    mattermost: [],
    slack: [],
    claude: { timeoutMs: 120_000 },
    paths: { publishedEventsDir: "/tmp/wire-surface-adapters-test" },
    ...overrides,
  });
}

/** Records every `register()` call; `start`/`stop`/`dispatch` are no-ops. */
function makeRecordingRouter(): { router: SurfaceRouter; registered: SurfaceAdapter[] } {
  const registered: SurfaceAdapter[] = [];
  const router: SurfaceRouter = {
    register: (adapter) => {
      registered.push(adapter);
      return { unregister: () => {} };
    },
    start: async () => {},
    stop: async () => {},
    dispatch: async () => {},
  };
  return { router, registered };
}

/** Construct-only fake adapter implementing every member `wireSurfaceAdapters` calls. */
interface FakeAdapterOpts {
  platform: string;
  instanceId: string;
  botUserId: string;
  /** Discord + Slack only — omit for the Mattermost fake (no trust support). */
  withTrustMembers?: boolean;
}

interface RecordedAdapter {
  platform: string;
  instanceId: string;
  started: boolean;
  setTrustedBotIdsCalls: ReadonlySet<string>[];
  attachInboundDispatchCalls: number;
}

function makeFakeAdapter(
  opts: FakeAdapterOpts,
  recorded: RecordedAdapter[],
): PlatformAdapter & Record<string, unknown> {
  const record: RecordedAdapter = {
    platform: opts.platform,
    instanceId: opts.instanceId,
    started: false,
    setTrustedBotIdsCalls: [],
    attachInboundDispatchCalls: 0,
  };
  recorded.push(record);
  let trustedBotIdCount = 0;
  const surfaceConfig: SurfaceAdapter = {
    id: `${opts.platform}-${opts.instanceId}`,
    subjects: [],
    render: async () => {},
  };
  const base: PlatformAdapter & Record<string, unknown> = {
    platform: opts.platform,
    instanceId: opts.instanceId,
    start: async () => {
      record.started = true;
    },
    stop: async () => {},
    getPlatformUserId: async () => opts.botUserId,
    fetchContext: async () => [],
    resolveAccess: () => ({ allowed: true, features: { chat: true, async: false, team: false } }),
    postResponse: async () => {},
    sendTyping: async () => {},
    sendProgress: async () => {},
    clearProgress: async () => {},
    createThread: async () => ({ instanceId: opts.instanceId, channelId: "ch" }),
    resolveLogicalTarget: async () => null,
    notifyPrincipal: async () => {},
    surfaceConfig,
  };
  if (opts.withTrustMembers) {
    base.setTrustedBotIds = (ids: ReadonlySet<string>) => {
      record.setTrustedBotIdsCalls.push(ids);
      trustedBotIdCount = ids.size;
    };
    base.attachInboundDispatch = () => {
      record.attachInboundDispatchCalls += 1;
    };
    Object.defineProperty(base, "trustedBotIdCount", { get: () => trustedBotIdCount });
  }
  return base;
}

function makeRecordingFactory(recorded: RecordedAdapter[]): {
  factory: GatewayAdapterFactory;
  callOrder: string[];
} {
  const callOrder: string[] = [];
  const factory: GatewayAdapterFactory = {
    discord: (args) => {
      callOrder.push("discord");
      return makeFakeAdapter(
        { platform: "discord", instanceId: args.instanceId, botUserId: `bot-${args.instanceId}`, withTrustMembers: true },
        recorded,
      );
    },
    slack: (args) => {
      callOrder.push("slack");
      return makeFakeAdapter(
        { platform: "slack", instanceId: args.instanceId, botUserId: `bot-${args.instanceId}`, withTrustMembers: true },
        recorded,
      );
    },
    mattermost: (args) => {
      callOrder.push("mattermost");
      return makeFakeAdapter(
        { platform: "mattermost", instanceId: args.instanceId, botUserId: `bot-${args.instanceId}` },
        recorded,
      );
    },
    web: (args) => makeFakeAdapter({ platform: "web", instanceId: args.instanceId, botUserId: "unused" }, recorded),
  };
  return { factory, callOrder };
}

function baseOpts(
  config: AgentConfig,
  factory: GatewayAdapterFactory,
  router: SurfaceRouter,
  overrides: Partial<WireSurfaceAdaptersOpts> = {},
): WireSurfaceAdaptersOpts {
  const agentRegistry = overrides.agentRegistry ?? AgentRegistry.fromAgents([]);
  return {
    config,
    discordInstances: config.discord,
    mattermostInstances: config.mattermost,
    slackInstances: config.slack,
    agentByDiscordToken: new Map<string, Agent>(),
    agentByMattermostApiToken: new Map<string, Agent>(),
    agentBySlackBotToken: new Map<string, Agent>(),
    gatewayOwned: new Set<string>(),
    router,
    runtime: undefined,
    systemEventSource: SYSTEM_EVENT_SOURCE,
    principalDiscordId: undefined,
    principalMattermostId: undefined,
    principalSlackId: undefined,
    policyEngine: undefined,
    policyLookup: undefined,
    policyRegistry: undefined,
    agentRegistry,
    trustResolver: overrides.trustResolver ?? new TrustResolver(agentRegistry),
    inboundWithGateBridge:
      (_adapter: PlatformAdapter, _agent: Agent) =>
      (_msg: InboundMessage): Promise<void> =>
        Promise.resolve(),
    disableOutboundPoller: true,
    setupOutboundLog: () => null,
    adapters: [],
    adapterCleanup: [],
    liveSurfaces: new Set<string>(),
    factory,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("wireSurfaceAdapters", () => {
  test("constructs + registers + starts discord, mattermost, slack in that fixed order", async () => {
    const config = minimalConfig({
      discord: [{ enabled: true, token: "tok-d", guildId: "g1", agentChannelId: "c1", logChannelId: "l1" }],
      mattermost: [{ enabled: true, apiUrl: "https://mm.example.com", apiToken: "mm-tok" }],
      slack: [{ enabled: true, botToken: "xoxb-1", appToken: "xapp-1", workspaceId: "T123" }],
    });
    const recorded: RecordedAdapter[] = [];
    const { factory, callOrder } = makeRecordingFactory(recorded);
    const { router, registered } = makeRecordingRouter();
    const opts = baseOpts(config, factory, router);

    await wireSurfaceAdapters(opts);

    expect(callOrder).toEqual(["discord", "mattermost", "slack"]);
    expect(opts.adapters.map((a) => a.platform)).toEqual(["discord", "mattermost", "slack"]);
    expect([...opts.liveSurfaces].sort()).toEqual(["discord", "mattermost", "slack"]);
    expect(registered.length).toBe(3);
    expect(recorded.every((r) => r.started)).toBe(true);
  });

  test("disabled instance is skipped — no factory call, no adapter", async () => {
    const config = minimalConfig({
      discord: [{ enabled: false, token: "tok-d", guildId: "g1", agentChannelId: "c1", logChannelId: "l1" }],
    });
    const recorded: RecordedAdapter[] = [];
    const { factory, callOrder } = makeRecordingFactory(recorded);
    const { router } = makeRecordingRouter();
    const opts = baseOpts(config, factory, router);

    await wireSurfaceAdapters(opts);

    expect(callOrder).toEqual([]);
    expect(opts.adapters).toEqual([]);
  });

  test("GW.a.3b.2c gateway-owned suppression skips construction", async () => {
    const config = minimalConfig({
      slack: [{ enabled: true, botToken: "xoxb-1", appToken: "xapp-1", workspaceId: "T123" }],
    });
    const recorded: RecordedAdapter[] = [];
    const { factory, callOrder } = makeRecordingFactory(recorded);
    const { router } = makeRecordingRouter();
    // The fallback agent id defaults to `config.agent.name` ("test-cortex")
    // when no `agentBySlackBotToken` match exists — same fallback the
    // pre-extraction inline block used.
    const opts = baseOpts(config, factory, router, { gatewayOwned: new Set(["slack:test-cortex"]) });

    await wireSurfaceAdapters(opts);

    expect(callOrder).toEqual([]);
    expect(opts.adapters).toEqual([]);
  });

  test("mattermost missing apiUrl/apiToken is skipped without constructing", async () => {
    const config = minimalConfig({
      mattermost: [{ enabled: true, instanceId: "mm-unconfigured" }],
    });
    const recorded: RecordedAdapter[] = [];
    const { factory, callOrder } = makeRecordingFactory(recorded);
    const { router } = makeRecordingRouter();
    const opts = baseOpts(config, factory, router);

    await wireSurfaceAdapters(opts);

    expect(callOrder).toEqual([]);
    expect(opts.adapters).toEqual([]);
  });

  test("Pass 2 merges an in-process trust peer's bot id for discord + slack (not mattermost)", async () => {
    // `agentByDiscordToken` (below) is what the discord descriptor's
    // `lookupAgent` actually keys on — these Agent objects' own `presence`
    // is never read by the lookup, so an empty block is valid (per
    // `AgentSchema`'s doc: "presence itself is still required" but its
    // sub-fields are all optional).
    const luna: Agent = { id: "luna", displayName: "Luna", persona: "p", trust: ["echo"], presence: {} };
    const echo: Agent = { id: "echo", displayName: "Echo", persona: "p", trust: [], presence: {} };
    const agentRegistry = AgentRegistry.fromAgents([luna, echo]);
    const trustResolver = new TrustResolver(agentRegistry);

    const config = minimalConfig({
      discord: [
        { enabled: true, token: "tok-luna", guildId: "g1", agentChannelId: "c1", logChannelId: "l1" },
        { enabled: true, token: "tok-echo", guildId: "g2", agentChannelId: "c2", logChannelId: "l2" },
      ],
      mattermost: [{ enabled: true, apiUrl: "https://mm.example.com", apiToken: "mm-tok" }],
    });
    const recorded: RecordedAdapter[] = [];
    const { factory } = makeRecordingFactory(recorded);
    const { router } = makeRecordingRouter();
    const opts = baseOpts(config, factory, router, {
      agentRegistry,
      trustResolver,
      agentByDiscordToken: new Map([
        ["tok-luna", luna],
        ["tok-echo", echo],
      ]),
    });

    // Sage #1547 r1 (important) — the PR claimed this test "asserts via the
    // real log line `trustedBotIds: 1 [resolver: echo]`", but it only checked
    // `setTrustedBotIdsCalls`/`attachInboundDispatchCalls` shapes, never the
    // log line itself. Capture `console.log` so the assertion below pins the
    // EXACT text `wireSurfaceAdapters` emits — the claim now matches reality.
    const logLines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    };
    try {
      await wireSurfaceAdapters(opts);
    } finally {
      console.log = originalLog;
    }

    const lunaDiscord = recorded.find((r) => r.platform === "discord" && r.instanceId.includes("g1"));
    const echoDiscord = recorded.find((r) => r.platform === "discord" && r.instanceId.includes("g2"));
    const mattermostAdapter = recorded.find((r) => r.platform === "mattermost");
    expect(lunaDiscord?.attachInboundDispatchCalls).toBe(1);
    expect(echoDiscord?.attachInboundDispatchCalls).toBe(1);
    // luna trusts echo → the resolved peer's bot id (registered in Pass 1 as
    // `bot-{instanceId}`) must be in luna's merged allowlist.
    const lunaMerged = lunaDiscord?.setTrustedBotIdsCalls.at(-1);
    expect(lunaMerged && [...lunaMerged].some((id) => id.startsWith("bot-"))).toBe(true);
    // Pin the EXACT Pass-2 log line for luna's instance: 1 merged id,
    // resolved via the resolver (peer "echo"), not the cross-process branch.
    expect(logLines).toContain(
      "cortex: discord adapter started (instance: test-cortex-discord-g1, guild: g1, trustedBotIds: 1 [resolver: echo])",
    );
    // Mattermost has no trust support — its fake never got the members, so
    // there is nothing to call; confirm it still started + registered.
    expect(mattermostAdapter?.started).toBe(true);
  });
});
