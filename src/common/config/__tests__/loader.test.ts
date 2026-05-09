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
