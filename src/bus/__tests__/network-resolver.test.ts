/**
 * G-500: Network Resolver Tests
 * Tests for guild/channel → network lookups.
 */

import { test, expect, describe } from "bun:test";
import {
  createNetworkResolver,
  getNetworkForGuild,
  getNetworkForChannel,
  buildNetworkLookups,
} from "../network-resolver";
import type { BotConfig } from "../../common/types/config";
import type { NetworkFile } from "../../common/types/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNetwork(id: string, overrides: Partial<NetworkFile> = {}): NetworkFile {
  return {
    id,
    cloud: {
      endpoint: `https://${id}.workers.dev`,
      apiKey: `grove_sk_${id}`,
      operatorId: `op-${id}`,
    },
    discord: [],
    mattermost: [],
    github: { repos: [], webhookSecret: "", iterationLabel: "iteration", agentDetection: { commitTrailers: [], branchPatterns: [], commentPatterns: [] } },
    ...overrides,
  };
}

function makeConfig(networks: NetworkFile[]): BotConfig {
  return {
    agent: { name: "test", displayName: "Test" },
    discord: networks.flatMap(n => n.discord),
    mattermost: networks.flatMap(n => n.mattermost),
    claude: {
      timeoutMs: 120000,
      asyncTimeoutMs: 900000,
      additionalArgs: [],
      allowedTools: [],
      disallowedTools: [],
      allowedDirs: [],
      readOnlyDirs: [],
    },
    attachments: {
      enabled: true,
      maxFileSizeBytes: 10485760,
      maxTotalSizeBytes: 26214400,
      maxAttachmentsPerMessage: 10,
    },
    execution: { default: "local", backends: [] },
    github: { webhookSecret: "", repos: [], agentDetection: { commitTrailers: [], branchPatterns: [], commentPatterns: [] } },
    api: { enabled: false, port: 8766, corsOrigin: "*", mode: "local" as const },
    paths: { publishedEventsDir: "/tmp/events", logDir: "/tmp/logs" },
    networksDir: "./networks",
    networks,
  } as any;
}

// ---------------------------------------------------------------------------
// T6.5: Guild → network lookup
// ---------------------------------------------------------------------------

describe("getNetworkForGuild", () => {
  test("resolves guild ID to correct network", () => {
    const config = makeConfig([
      makeNetwork("alpha", {
        discord: [{ token: "t1", guildId: "guild-a", agentChannelId: "c", logChannelId: "l", contextDepth: 10, enableAgentLog: false, roles: [], defaultRole: "allow-all", enabled: true, dm: {} as any }] as any,
      }),
      makeNetwork("beta", {
        discord: [{ token: "t2", guildId: "guild-b", agentChannelId: "c", logChannelId: "l", contextDepth: 10, enableAgentLog: false, roles: [], defaultRole: "allow-all", enabled: true, dm: {} as any }] as any,
      }),
    ]);

    expect(getNetworkForGuild("guild-a", config)).toBe("alpha");
    expect(getNetworkForGuild("guild-b", config)).toBe("beta");
  });

  test("returns undefined for unknown guild", () => {
    const config = makeConfig([
      makeNetwork("alpha", {
        discord: [{ token: "t1", guildId: "guild-a", agentChannelId: "c", logChannelId: "l", contextDepth: 10, enableAgentLog: false, roles: [], defaultRole: "allow-all", enabled: true, dm: {} as any }] as any,
      }),
    ]);

    expect(getNetworkForGuild("unknown-guild", config)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T6.6: Channel → network lookup
// ---------------------------------------------------------------------------

describe("getNetworkForChannel", () => {
  test("resolves Mattermost channel to correct network", () => {
    const config = makeConfig([
      makeNetwork("workplace", {
        mattermost: [{ apiUrl: "https://mm.example.com", apiToken: "t", channels: ["ch-1", "ch-2"], enabled: true, pollIntervalMs: 3000, allowedUsers: [], roles: [], defaultRole: "allow-all", callbackPort: 8080 }],
      }),
      makeNetwork("personal", {
        mattermost: [{ apiUrl: "https://mm2.example.com", apiToken: "t", channels: ["ch-3"], enabled: true, pollIntervalMs: 3000, allowedUsers: [], roles: [], defaultRole: "allow-all", callbackPort: 8081 }],
      }),
    ]);

    expect(getNetworkForChannel("ch-1", config)).toBe("workplace");
    expect(getNetworkForChannel("ch-2", config)).toBe("workplace");
    expect(getNetworkForChannel("ch-3", config)).toBe("personal");
  });

  test("returns undefined for unknown channel", () => {
    const config = makeConfig([
      makeNetwork("workplace", {
        mattermost: [{ apiUrl: "https://mm.example.com", apiToken: "t", channels: ["ch-1"], enabled: true, pollIntervalMs: 3000, allowedUsers: [], roles: [], defaultRole: "allow-all", callbackPort: 8080 }],
      }),
    ]);

    expect(getNetworkForChannel("unknown-ch", config)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T6.7: NetworkResolver for CloudPublisher
// ---------------------------------------------------------------------------

describe("createNetworkResolver", () => {
  test("resolves network by ID for cloud publisher", () => {
    const config = makeConfig([
      makeNetwork("alpha"),
      makeNetwork("beta"),
    ]);

    const resolver = createNetworkResolver(config);

    const alphaConfig = resolver("alpha");
    expect(alphaConfig).not.toBeNull();
    expect(alphaConfig!.id).toBe("alpha");
    expect(alphaConfig!.endpoint).toBe("https://alpha.workers.dev");
    expect(alphaConfig!.apiKey).toBe("grove_sk_alpha");
    expect(alphaConfig!.operatorId).toBe("op-alpha");

    const betaConfig = resolver("beta");
    expect(betaConfig).not.toBeNull();
    expect(betaConfig!.id).toBe("beta");
  });

  test("returns null for unknown network ID", () => {
    const config = makeConfig([makeNetwork("alpha")]);
    const resolver = createNetworkResolver(config);

    expect(resolver("nonexistent")).toBeNull();
  });

  test("returns null when network has no cloud config", () => {
    const config = makeConfig([makeNetwork("local-only", { cloud: undefined })]);
    const resolver = createNetworkResolver(config);

    expect(resolver("local-only")).toBeNull();
  });

  test("returns first cloud network for undefined networkId", () => {
    const config = makeConfig([
      makeNetwork("alpha"),
      makeNetwork("beta"),
    ]);
    const resolver = createNetworkResolver(config);

    // undefined = "default" behavior — return first network with cloud config
    const result = resolver(undefined);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// buildNetworkLookups
// ---------------------------------------------------------------------------

describe("buildNetworkLookups", () => {
  test("builds lookup tables from config", () => {
    const config = makeConfig([
      makeNetwork("alpha", {
        discord: [{ token: "t", guildId: "g1", agentChannelId: "c", logChannelId: "l", contextDepth: 10, enableAgentLog: false, roles: [], defaultRole: "allow-all", enabled: true, dm: {} as any }] as any,
      }),
      makeNetwork("beta", {
        mattermost: [{ apiUrl: "https://mm", apiToken: "t", channels: ["ch-1", "ch-2"], enabled: true, pollIntervalMs: 3000, allowedUsers: [], roles: [], defaultRole: "allow-all", callbackPort: 8080 }],
      }),
    ]);

    const lookups = buildNetworkLookups(config);
    expect(lookups.guildToNetwork.get("g1")).toBe("alpha");
    expect(lookups.channelToNetwork.get("ch-1")).toBe("beta");
    expect(lookups.channelToNetwork.get("ch-2")).toBe("beta");
    expect(lookups.networksById.get("alpha")?.id).toBe("alpha");
    expect(lookups.networksById.get("beta")?.id).toBe("beta");
  });
});
