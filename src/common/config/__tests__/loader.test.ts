/**
 * G-500: Config Loader Tests
 * Tests for multi-network config loading (central bot.yaml + per-network files).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import { loadConfig } from "../loader";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let testDir: string;

function setupTestDir(): string {
  const dir = join(tmpdir(), `grove-config-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "networks"), { recursive: true });
  return dir;
}

function writeCentralConfig(dir: string, config: Record<string, unknown>): string {

  const path = join(dir, "bot.yaml");
  writeFileSync(path, stringify(config));
  return path;
}

function writeNetworkFile(dir: string, filename: string, config: Record<string, unknown>): void {

  writeFileSync(join(dir, "networks", filename), stringify(config));
}

/** Minimal valid central config */
function minimalCentral(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: { name: "test-bot", displayName: "TestBot" },
    claude: { timeoutMs: 120000 },
    networksDir: "./networks",
    ...overrides,
  };
}

/** Minimal valid network file */
function minimalNetwork(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    cloud: {
      endpoint: `https://${id}.workers.dev`,
      apiKey: `grove_sk_${id}`,
      operatorId: `op-${id}`,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDir = setupTestDir();
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T6.1: Valid multi-network config
// ---------------------------------------------------------------------------

describe("multi-network config loading", () => {
  test("loads central config + two network files", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "alpha.yaml", minimalNetwork("alpha", {
      discord: [{ token: "tok-a", guildId: "guild-a", agentChannelId: "ch-a", logChannelId: "log-a" }],
    }));
    writeNetworkFile(testDir, "beta.yaml", minimalNetwork("beta", {
      mattermost: [{ apiUrl: "https://mm.example.com", apiToken: "tok-b", channels: ["ch-b1"] }],
    }));

    const config = loadConfig(configPath);

    expect(config.networks).toHaveLength(2);
    expect(config.networks.map(n => n.id).sort()).toEqual(["alpha", "beta"]);

    // Flattened arrays aggregate from all networks
    expect(config.discord).toHaveLength(1);
    expect(config.discord[0]!.guildId).toBe("guild-a");
    expect(config.mattermost).toHaveLength(1);
    expect(config.mattermost[0]!.apiUrl).toBe("https://mm.example.com");
  });

  test("network file without cloud section is valid (local-only network)", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "local.yaml", {
      id: "local",
      discord: [{ token: "tok", guildId: "g1", agentChannelId: "c1", logChannelId: "l1" }],
    });

    const config = loadConfig(configPath);
    expect(config.networks).toHaveLength(1);
    expect(config.networks[0]!.id).toBe("local");
    expect(config.networks[0]!.cloud).toBeUndefined();
  });

  test("per-network claude overrides are preserved", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral({
      claude: { timeoutMs: 300000, allowedDirs: ["/global"] },
    }));
    writeNetworkFile(testDir, "secure.yaml", minimalNetwork("secure", {
      claude: { allowedDirs: ["/restricted"], disallowedTools: ["Bash"] },
    }));

    const config = loadConfig(configPath);
    const network = config.networks.find(n => n.id === "secure")!;
    expect(network.claude?.allowedDirs).toEqual(["/restricted"]);
    expect(network.claude?.disallowedTools).toEqual(["Bash"]);

    // Global claude settings preserved
    expect(config.claude.timeoutMs).toBe(300000);
  });
});

// ---------------------------------------------------------------------------
// T6.2: Duplicate network ID rejection
// ---------------------------------------------------------------------------

describe("duplicate network ID rejection", () => {
  test("throws on duplicate network IDs across files", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "first.yaml", minimalNetwork("same-id"));
    writeNetworkFile(testDir, "second.yaml", minimalNetwork("same-id"));

    expect(() => loadConfig(configPath)).toThrow(/duplicate network id/i);
  });
});

// ---------------------------------------------------------------------------
// T6.3: Missing networksDir fallback (legacy mode)
// ---------------------------------------------------------------------------

describe("legacy fallback", () => {
  test("works without networksDir when discord/mattermost in bot.yaml", () => {
    // Legacy format: everything in one file, no networksDir
    const configPath = writeCentralConfig(testDir, {
      agent: { name: "legacy-bot", displayName: "LegacyBot" },
      claude: { timeoutMs: 120000 },
      discord: { token: "tok", guildId: "g1", agentChannelId: "c1", logChannelId: "l1" },
      api: { mode: "cloud", endpoint: "https://api.example.com", apiKey: "sk_123", operatorId: "op1" },
    });

    // Remove networks dir to simulate legacy
    rmSync(join(testDir, "networks"), { recursive: true });

    const config = loadConfig(configPath);
    expect(config.networks).toHaveLength(1);
    expect(config.networks[0]!.id).toBe("default");
    expect(config.discord).toHaveLength(1);
  });

  test("empty networksDir creates no networks (beyond legacy fallback)", () => {
    const configPath = writeCentralConfig(testDir, {
      agent: { name: "empty-bot", displayName: "EmptyBot" },
      claude: { timeoutMs: 120000 },
      networksDir: "./networks",
    });
    // networks/ dir exists but is empty

    const config = loadConfig(configPath);
    expect(config.networks).toHaveLength(0);
    expect(config.discord).toHaveLength(0);
    expect(config.mattermost).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cortex#88 item 7: networksDir-missing log level
// ---------------------------------------------------------------------------

describe("networksDir-missing log level (cortex#88 item 7)", () => {
  function captureConsole(): {
    logs: { kind: "info" | "warn"; msg: string }[];
    restore: () => void;
  } {
    const logs: { kind: "info" | "warn"; msg: string }[] = [];
    const origInfo = console.info;
    const origWarn = console.warn;
    console.info = (...args: unknown[]) => {
      logs.push({ kind: "info", msg: args.map(String).join(" ") });
    };
    console.warn = (...args: unknown[]) => {
      logs.push({ kind: "warn", msg: args.map(String).join(" ") });
    };
    return {
      logs,
      restore: () => {
        console.info = origInfo;
        console.warn = origWarn;
      },
    };
  }

  test("default networksDir absent → info-level only (no warn)", () => {
    // migrate-config emits `networksDir: ./networks` even when the operator
    // never created the directory. Make sure that the default-value-absent
    // case is informational, not a warning.
    const configPath = writeCentralConfig(testDir, {
      agent: { name: "luna", displayName: "Luna" },
      claude: { timeoutMs: 120000 },
      networksDir: "./networks",
    });
    rmSync(join(testDir, "networks"), { recursive: true });

    const cap = captureConsole();
    try {
      loadConfig(configPath);
    } finally {
      cap.restore();
    }
    const warns = cap.logs.filter((l) => l.kind === "warn" && l.msg.includes("networksDir"));
    expect(warns).toHaveLength(0);
    const infos = cap.logs.filter((l) => l.kind === "info" && l.msg.includes("networksDir"));
    expect(infos.length).toBeGreaterThan(0);
  });

  test("non-default networksDir absent → keeps console.warn", () => {
    // Operator explicitly pointed networksDir at a non-default path that
    // doesn't exist — that's almost certainly a typo or missing mount,
    // worth surfacing loudly.
    const configPath = writeCentralConfig(testDir, {
      agent: { name: "luna", displayName: "Luna" },
      claude: { timeoutMs: 120000 },
      networksDir: "./operator-typo-here",
    });

    const cap = captureConsole();
    try {
      loadConfig(configPath);
    } finally {
      cap.restore();
    }
    const warns = cap.logs.filter(
      (l) =>
        l.kind === "warn" &&
        l.msg.includes("networksDir") &&
        l.msg.includes("does not exist"),
    );
    expect(warns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T6.4: Malformed network file error reporting
// ---------------------------------------------------------------------------

describe("error reporting", () => {
  test("includes filename in validation error", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "bad.yaml", { id: "" }); // Invalid: empty id

    try {
      loadConfig(configPath);
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.message).toContain("bad.yaml");
    }
  });

  test("rejects network ID with uppercase or special chars", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "bad.yaml", minimalNetwork("Bad_Network!"));

    expect(() => loadConfig(configPath)).toThrow(/bad\.yaml/i);
  });
});

// =============================================================================
// MIG-7.2e — cortex-shape config (operator: + agents:[]) loading
// =============================================================================
//
// `loadConfigWithAgents` accepts both legacy bot.yaml and cortex.yaml. The
// detection is structural (operator: object + agents: non-empty array). For
// cortex shape, the loader synthesizes a legacy-compatible BotConfig and
// returns the rich agents[] alongside via `inlineAgents` so `startCortex`
// can route per-instance identity correctly.

import { loadConfigWithAgents } from "../loader";

describe("MIG-7.2e — cortex-shape detection + transform", () => {
  function writeCortexConfig(dir: string, config: Record<string, unknown>): string {
    const path = join(dir, "cortex.yaml");
    writeFileSync(path, stringify(config));
    return path;
  }

  function minimalCortex(): Record<string, unknown> {
    return {
      operator: {
        id: "jc",
        displayName: "Jens-Christian",
        discordId: "285727653603049472",
      },
      agents: [
        {
          id: "ivy",
          displayName: "Ivy",
          persona: "./personas/ivy.md",
          roles: [],
          trust: ["luna"],
          presence: {
            discord: {
              token: "fake-token-ivy",
              guildId: "1487023327791808592",
              agentChannelId: "1487029848164536361",
              logChannelId: "1487029942129524786",
            },
          },
        },
      ],
      claude: {},
    };
  }

  test("loadConfigWithAgents detects cortex shape and returns inlineAgents", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const loaded = loadConfigWithAgents(path);
    expect(loaded.inlineAgents).toHaveLength(1);
    expect(loaded.inlineAgents[0]!.id).toBe("ivy");
    expect(loaded.inlineAgents[0]!.displayName).toBe("Ivy");
    expect(loaded.inlineAgents[0]!.trust).toEqual(["luna"]);
  });

  test("synthesizes BotConfig.agent from operator + first agent", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const { config } = loadConfigWithAgents(path);
    expect(config.agent.name).toBe("ivy");
    expect(config.agent.displayName).toBe("Ivy");
    expect(config.agent.operatorId).toBe("jc");
    expect(config.agent.operatorDiscordId).toBe("285727653603049472");
    expect(config.agent.operatorName).toBe("Jens-Christian");
  });

  test("flattens agents[*].presence.discord into BotConfig.discord[]", () => {
    const cfg = minimalCortex();
    (cfg.agents as Record<string, unknown>[]).push({
      id: "holly",
      displayName: "Holly",
      persona: "./personas/holly.md",
      roles: [],
      trust: ["ivy"],
      presence: {
        discord: {
          token: "fake-token-holly",
          guildId: "1487023327791808592",
          agentChannelId: "1487029848164536361",
          logChannelId: "1487029942129524786",
        },
      },
    });
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.discord).toHaveLength(2);
    expect(config.discord[0]!.token).toBe("fake-token-ivy");
    expect(config.discord[1]!.token).toBe("fake-token-holly");
    // MIG-7.2c convention: instanceId = ${agent.id}-discord (collapsed post-MIG-7.2e)
    expect(config.discord[0]!.instanceId).toBe("ivy-discord");
    expect(config.discord[1]!.instanceId).toBe("holly-discord");
  });

  test("passes nats block through verbatim", () => {
    const cfg = minimalCortex();
    cfg.nats = {
      url: "nats://127.0.0.1:4222",
      identity: {
        seedPath: "/tmp/cortex.nk",
        publicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.nats?.url).toBe("nats://127.0.0.1:4222");
    expect(config.nats?.identity?.publicKey).toBe(
      "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
  });

  test("legacy shape continues to return empty inlineAgents", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    const loaded = loadConfigWithAgents(configPath);
    expect(loaded.inlineAgents).toEqual([]);
    expect(loaded.config.agent.name).toBeDefined();
  });

  test("loadConfig backward-compat wrapper still returns BotConfig only", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const cfg = loadConfig(path);
    expect(cfg.agent.name).toBe("ivy");
    // Type sanity — no inlineAgents on the BotConfig
    expect((cfg as Record<string, unknown>).inlineAgents).toBeUndefined();
  });

  test("rejects cortex.yaml carrying legacy top-level `agent:`", () => {
    const cfg = minimalCortex();
    cfg.agent = { name: "ivy", displayName: "Ivy" };
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(/legacy `agent:`.*not supported/);
  });

  test("rejects cortex.yaml carrying legacy top-level `discord:`", () => {
    const cfg = minimalCortex();
    cfg.discord = [{ token: "x", guildId: "1", agentChannelId: "2", logChannelId: "3" }];
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(/legacy top-level `discord:`/);
  });

  test("rejects cortex.yaml carrying legacy top-level `trustedAgentBots:`", () => {
    const cfg = minimalCortex();
    cfg.trustedAgentBots = [{ id: "1487180524542890144", role: "agent-restricted" }];
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(/legacy `trustedAgentBots:`/);
  });

  test("operator-only with no agents falls back to legacy parse (detection requires both)", () => {
    const partial = { operator: { id: "jc" } };
    const path = writeCortexConfig(testDir, partial);
    // Falls into the legacy branch; BotConfigSchema rejects missing agent.name
    expect(() => loadConfigWithAgents(path)).toThrow();
  });

  test("agents-only with no operator falls back to legacy parse (detection requires both)", () => {
    const partial = { agents: [{ id: "ivy" }] };
    const path = writeCortexConfig(testDir, partial);
    expect(() => loadConfigWithAgents(path)).toThrow();
  });

  // cortex#98 (part A) — schema parity: `presence.discord.trustedBotIds`
  // is preserved through the cortex-shape → legacy BotConfig synthesizer.
  // Before this fix, DiscordPresenceSchema lacked the field entirely and
  // zod's default unknown-key-strip behaviour silently dropped the
  // operator-set value during `CortexConfigSchema.parse`, leaving the
  // downstream DiscordInstance.trustedBotIds at its schema default ([]).
  test("threads agents[].presence.discord.trustedBotIds through to DiscordInstance.trustedBotIds", () => {
    const cfg = minimalCortex();
    const firstAgent = (cfg.agents as Record<string, unknown>[])[0]!;
    const discordPresence = (firstAgent.presence as Record<string, unknown>).discord as Record<string, unknown>;
    discordPresence.trustedBotIds = ["123", "456"];
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.discord).toHaveLength(1);
    expect(config.discord[0]!.trustedBotIds).toEqual(["123", "456"]);
  });

  test("trustedBotIds defaults to [] when omitted from presence.discord", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const { config } = loadConfigWithAgents(path);
    expect(config.discord[0]!.trustedBotIds).toEqual([]);
  });

  // cortex#205 — schema parity: `presence.discord.surfaceSubjects` is
  // preserved through the cortex-shape → legacy BotConfig synthesizer so
  // operators can wire bus-envelope subjects into the Discord adapter's
  // surface-router match set. Before this fix, the field was absent from
  // both DiscordPresenceSchema and DiscordInstanceSchema, so zod's
  // unknown-key-strip silently dropped any operator-set value.
  test("threads agents[].presence.discord.surfaceSubjects through to DiscordInstance.surfaceSubjects", () => {
    const cfg = minimalCortex();
    const firstAgent = (cfg.agents as Record<string, unknown>[])[0]!;
    const discordPresence = (firstAgent.presence as Record<string, unknown>).discord as Record<string, unknown>;
    discordPresence.surfaceSubjects = [
      "local.metafactory.tasks.code-review.>",
    ];
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.discord).toHaveLength(1);
    expect(config.discord[0]!.surfaceSubjects).toEqual([
      "local.metafactory.tasks.code-review.>",
    ]);
  });

  test("surfaceSubjects defaults to [] when omitted from presence.discord", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const { config } = loadConfigWithAgents(path);
    expect(config.discord[0]!.surfaceSubjects).toEqual([]);
  });

  // cortex#207 — companion field to surfaceSubjects: where the adapter
  // posts inbound bus envelopes. Without this, surfaceSubjects matches
  // but renderEnvelope drops the envelope with a one-shot warning.
  test("threads agents[].presence.discord.surfaceFallbackChannelId through to DiscordInstance.surfaceFallbackChannelId", () => {
    const cfg = minimalCortex();
    const firstAgent = (cfg.agents as Record<string, unknown>[])[0]!;
    const discordPresence = (firstAgent.presence as Record<string, unknown>).discord as Record<string, unknown>;
    discordPresence.surfaceFallbackChannelId = "1234567890";
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.discord).toHaveLength(1);
    expect(config.discord[0]!.surfaceFallbackChannelId).toBe("1234567890");
  });

  test("surfaceFallbackChannelId is undefined when omitted from presence.discord", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const { config } = loadConfigWithAgents(path);
    // Optional field — omission round-trips as undefined, not empty string.
    // The adapter's runtime guard discriminates on `=== undefined` to fire
    // the drop-with-warning path (preserves v0 behaviour for legacy configs).
    expect(config.discord[0]!.surfaceFallbackChannelId).toBeUndefined();
  });

  test("surfaceFallbackChannelId coerces a safely-representable numeric to a string", () => {
    // Discord snowflakes are 64-bit IDs that exceed Number.MAX_SAFE_INTEGER —
    // testing with a real snowflake as a JS Number literal silently rounds
    // at source-parse time and proves nothing about round-trip safety. Use
    // a small numeric to demonstrate ONLY the z.coerce.string() behavior:
    // operator passes a number, schema returns a string of that number.
    // The separate "preserves quoted snowflake string verbatim" test below
    // exercises the realistic path (operator quotes the snowflake in yaml).
    const cfg = minimalCortex();
    const firstAgent = (cfg.agents as Record<string, unknown>[])[0]!;
    const discordPresence = (firstAgent.presence as Record<string, unknown>).discord as Record<string, unknown>;
    // discordPresence is typed `Record<string, unknown>`, so a numeric
    // assignment doesn't need a cast — `unknown` accepts any value.
    discordPresence.surfaceFallbackChannelId = 12345;
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(typeof config.discord[0]!.surfaceFallbackChannelId).toBe("string");
    expect(config.discord[0]!.surfaceFallbackChannelId).toBe("12345");
  });

  test("surfaceFallbackChannelId preserves a quoted snowflake string verbatim", () => {
    // The realistic operator path: yaml configs surrounding `agentChannelId`,
    // `logChannelId`, etc. all quote Discord snowflakes as strings. Verify
    // a quoted snowflake survives the round-trip without any digit-loss
    // from JS Number precision.
    const snowflake = "1487029848164536361"; // Echo's actual agent-channel snowflake
    const cfg = minimalCortex();
    const firstAgent = (cfg.agents as Record<string, unknown>[])[0]!;
    const discordPresence = (firstAgent.presence as Record<string, unknown>).discord as Record<string, unknown>;
    discordPresence.surfaceFallbackChannelId = snowflake;
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.discord[0]!.surfaceFallbackChannelId).toBe(snowflake);
  });

  // ---------------------------------------------------------------------------
  // IAW Phase A.5 (refs cortex#113) — cortex-shape `stack:` block plumbed
  // through to `LoadedConfig.stack`. The boot path (`startCortex`) calls
  // `deriveStackId` on this; today no emit-subject behaviour changes —
  // that's A.5.5, blocked on myelin#113. These tests just verify the
  // wiring: declared block round-trips, omitted block stays undefined,
  // malformed block fails at parse with a clear regex error.
  // ---------------------------------------------------------------------------

  test("IAW A.5.3 — declared `stack: { id }` block round-trips on LoadedConfig.stack", () => {
    const cfg = minimalCortex();
    cfg.stack = { id: "andreas/research" };
    const path = writeCortexConfig(testDir, cfg);
    const loaded = loadConfigWithAgents(path);
    expect(loaded.stack).toBeDefined();
    expect(loaded.stack?.id).toBe("andreas/research");
    expect(loaded.stack?.nkey_pub).toBeUndefined();
  });

  test("IAW A.5.3 — omitted `stack:` block keeps LoadedConfig.stack undefined", () => {
    // Backward-compat path: cortex.yaml without a stack: block still parses,
    // and the loader returns `stack: undefined` so the boot path's
    // `deriveStackId` falls through to `${operator.id}/default`.
    const path = writeCortexConfig(testDir, minimalCortex());
    const loaded = loadConfigWithAgents(path);
    expect(loaded.stack).toBeUndefined();
  });

  test("IAW A.5.3 — declared `stack:` with `nkey_pub` round-trips both fields", () => {
    const validNkey =
      "U" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVZ"; // U + 55
    const cfg = minimalCortex();
    cfg.stack = { id: "andreas/research", nkey_pub: validNkey };
    const path = writeCortexConfig(testDir, cfg);
    const loaded = loadConfigWithAgents(path);
    expect(loaded.stack?.id).toBe("andreas/research");
    expect(loaded.stack?.nkey_pub).toBe(validNkey);
  });

  test("IAW A.5.3 — malformed `stack.id` (uppercase) fails at parse with regex error", () => {
    const cfg = minimalCortex();
    cfg.stack = { id: "Andreas/research" };
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(/stack\.id must match/);
  });

  test("IAW A.5.3 — legacy bot.yaml input leaves LoadedConfig.stack undefined", () => {
    // BotConfigSchema has no `stack:` field during the MIG-7.2 overlap
    // window. The legacy branch of `loadConfigWithAgents` must produce a
    // `LoadedConfig` with `stack: undefined` so the boot path's destructure
    // (`const { stack } = ...`) stays safe.
    const configPath = writeCentralConfig(testDir, minimalCentral());
    const loaded = loadConfigWithAgents(configPath);
    expect(loaded.stack).toBeUndefined();
  });
});
