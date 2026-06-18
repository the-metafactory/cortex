/**
 * G-500: Config Loader Tests
 * Tests for multi-network config loading (central bot.yaml + per-network files).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { stringify } from "yaml";
import {
  loadConfig,
  flattenDiscordPresences,
  flattenMattermostPresences,
  flattenSlackPresences,
} from "../loader";
import { AgentSchema, type Agent } from "../../types/cortex-config";

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
  // TC-4a (cortex#636): the single-file config read enforces chmod 600
  // (it carries platform bot tokens). Write fixtures 0600 so the gate passes.
  writeFileSync(path, stringify(config), { mode: 0o600 });
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
      principalId: `op-${id}`,
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
    // R2.I (cortex#436) — the legacy flat `api.operatorId` is rewritten into
    // the canonical cloud `principalId` by buildLegacyNetwork.
    expect(config.networks[0]!.cloud?.principalId).toBe("op1");
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
// R2.I (cortex#436) — cloud `operatorId` → `principalId` v4.0.0 BREAKING CUT.
// The canonical (and only) key is `principalId`. The legacy `operatorId` cloud
// alias accepted during the transition release is GONE: a cloud block carrying
// `operatorId` is now rejected as an unknown key (strict object). Principals
// run `cortex migrate-config` to rewrite a legacy `operatorId:`-shaped config.
// ---------------------------------------------------------------------------

describe("R2.I cloud principalId — v4.0.0 breaking cut", () => {
  test("canonical cloud `principalId` loads", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "alpha.yaml", {
      id: "alpha",
      cloud: {
        endpoint: "https://alpha.workers.dev",
        apiKey: "grove_sk_alpha",
        principalId: "andreas",
      },
    });

    const config = loadConfig(configPath);
    const alpha = config.networks.find((n) => n.id === "alpha");
    expect(alpha?.cloud?.principalId).toBe("andreas");
  });

  test("LEGACY cloud `operatorId` is now REJECTED (unknown key)", () => {
    // A pre-v4 network file carrying the deprecated `operatorId:` cloud key
    // no longer loads — the strict schema rejects the unknown key.
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "legacy.yaml", {
      id: "legacy",
      cloud: {
        endpoint: "https://legacy.workers.dev",
        apiKey: "grove_sk_legacy",
        operatorId: "andreas-legacy",
      },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });

  test("a cloud block carrying BOTH `principalId` and legacy `operatorId` is rejected (unknown key)", () => {
    // Previously a dual-key conflict; under the strict canonical-only schema
    // the legacy alias is simply an unknown key.
    const configPath = writeCentralConfig(testDir, minimalCentral());
    writeNetworkFile(testDir, "conflict.yaml", {
      id: "conflict",
      cloud: {
        endpoint: "https://conflict.workers.dev",
        apiKey: "grove_sk_conflict",
        principalId: "andreas",
        operatorId: "andreas-legacy",
      },
    });

    expect(() => loadConfig(configPath)).toThrow();
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
    // migrate-config emits `networksDir: ./networks` even when the principal
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
    // Principal explicitly pointed networksDir at a non-default path that
    // doesn't exist — that's almost certainly a typo or missing mount,
    // worth surfacing loudly.
    const configPath = writeCentralConfig(testDir, {
      agent: { name: "luna", displayName: "Luna" },
      claude: { timeoutMs: 120000 },
      networksDir: "./principal-typo-here",
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
// MIG-7.2e — cortex-shape config (principal: + agents:[]) loading
// =============================================================================
//
// `loadConfigWithAgents` accepts both legacy bot.yaml and cortex.yaml. The
// detection is structural (principal: object + agents: non-empty array). For
// cortex shape, the loader synthesizes a legacy-compatible AgentConfig and
// returns the rich agents[] alongside via `inlineAgents` so `startCortex`
// can route per-instance identity correctly.

import { applySeedAwareSigningDefault, loadConfigWithAgents } from "../loader";

describe("MIG-7.2e — cortex-shape detection + transform", () => {
  function writeCortexConfig(dir: string, config: Record<string, unknown>): string {
    const path = join(dir, "cortex.yaml");
    // TC-4a (cortex#636): the single-file config read enforces chmod 600
  // (it carries platform bot tokens). Write fixtures 0600 so the gate passes.
  writeFileSync(path, stringify(config), { mode: 0o600 });
    return path;
  }

  function minimalCortex(): Record<string, unknown> {
    return {
      principal: {
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

  test("synthesizes AgentConfig.agent from principal + first agent", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const { config, principal } = loadConfigWithAgents(path);
    expect(config.agent.name).toBe("ivy");
    expect(config.agent.displayName).toBe("Ivy");
    // cortex#429 PR-C — `agent.operatorId/operatorName` retired from
    // AgentConfig.agent. Principal identity + display name now live on
    // `LoadedConfig.principal`.
    expect(principal?.id).toBe("jc");
    expect(principal?.displayName).toBe("Jens-Christian");
    expect(principal?.discordId).toBe("285727653603049472");
  });

  // fix/c-844 — the mc:/cockpit: blocks must survive the cortex-shape parse.
  // They were defined on AgentConfigSchema only; CortexConfigSchema's
  // strip-by-default parse silently dropped them, so `mc.enabled: true` in a
  // live config-split stack re-defaulted to false and MC never booted. These
  // tests pin BOTH directions (present → carried; absent → defaulted) on the
  // cortex shape specifically — the legacy-schema tests passed all along, which
  // is exactly why the divergence went unnoticed until the live deploy.
  test("carries mc + cockpit through the cortex-shape parse when enabled", () => {
    const cfg = minimalCortex();
    cfg.mc = { enabled: true, dbPath: "/tmp/mc-test/mission-control.db" };
    cfg.cockpit = { enabled: true, repo: "the-metafactory/cortex", docsDir: "/tmp/docs" };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.mc.enabled).toBe(true);
    expect(config.mc.dbPath).toBe("/tmp/mc-test/mission-control.db");
    expect(config.cockpit.enabled).toBe(true);
    expect(config.cockpit.repo).toBe("the-metafactory/cortex");
  });

  test("defaults mc + cockpit to disabled on the cortex shape when absent", () => {
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, minimalCortex()));
    expect(config.mc.enabled).toBe(false);
    expect(config.mc.port).toBe(0);
    expect(config.cockpit.enabled).toBe(false);
    // Inner defaults still re-applied via the shared transform.
    expect(config.cockpit.attention.surface).toBe("discord");
  });

  // fix/c-844 — the grove: block (F-11 Discord toggle + dashboard deep-link
  // baseUrl) must survive the cortex-shape parse, for the SAME reason as
  // mc:/cockpit: above. It was defined on AgentConfigSchema only, so
  // CortexConfigSchema's strip-by-default parse dropped it — `config.grove.
  // baseUrl` was always re-defaulted on every live config-split stack and the
  // attention-notification deep-links (cortex.ts:2713/2745) fell back to
  // localhost. These pin BOTH directions (present → carried; absent → defaulted)
  // on the cortex shape specifically.
  test("carries grove through the cortex-shape parse when configured", () => {
    const cfg = minimalCortex();
    cfg.grove = { baseUrl: "https://grove.meta-factory.ai", notifications: { discord: true } };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.grove.baseUrl).toBe("https://grove.meta-factory.ai");
    expect(config.grove.notifications.discord).toBe(true);
  });

  test("defaults grove to empty baseUrl + discord off on the cortex shape when absent", () => {
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, minimalCortex()));
    // Empty string (not undefined) is load-bearing: cortex.ts deep-link code
    // tests `config.grove.baseUrl !== ""` to decide the localhost fallback.
    expect(config.grove.baseUrl).toBe("");
    // Inner notifications default still re-applied via the shared transform —
    // `config.grove.notifications` must be defined (a read of `.discord` would
    // otherwise throw when grove is absent).
    expect(config.grove.notifications.discord).toBe(false);
  });

  test("flattens agents[*].presence.discord into AgentConfig.discord[]", () => {
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

  test("TC-0 (#628): carries the cortex.yaml security block through to AgentConfig.security", () => {
    // Regression guard for the silent-strip bug: pre-fix, `security:` was not
    // a field on CortexConfigSchema, so a principal-declared block was stripped
    // and `resolveSigningKnobs` silently defaulted to `off` — a fail-OPEN
    // downgrade for every cortex-shape deployment. This pins the passthrough.
    const cfg = minimalCortex();
    cfg.security = {
      signing: "enforce",
      encryption: { payload: "require", at_rest: "on" },
      transport: { mtls: "require" },
    };
    const path = writeCortexConfig(testDir, cfg);
    const { config } = loadConfigWithAgents(path);
    expect(config.security.signing).toBe("enforce");
    expect(config.security.encryption.payload).toBe("require");
    expect(config.security.encryption.at_rest).toBe("on");
    expect(config.security.transport.mtls).toBe("require");
  });

  test("TC-0 (#628): security absent on a cortex-shape config → all-off default (backward-compat)", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const { config } = loadConfigWithAgents(path);
    expect(config.security).toEqual({
      signing: "off",
      encryption: { payload: "off", at_rest: "off" },
      transport: { mtls: "off" },
    });
  });

  // cortex#1000 — seed-aware secure default. A configured stack signing seed
  // with NO explicit `security.signing` must boot `permissive`, not the
  // schema's `off` (the forged-stamp-injection defaults gap). Explicit values
  // — including `off` — always win; seedless stacks keep the all-off default
  // (pinned by the backward-compat test above).
  test("cortex#1000: signing seed + security.signing unset → defaults to permissive", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.security.signing).toBe("permissive");
    // Only the signing toggle bumps — the other posture layers keep `off`.
    expect(config.security.encryption.payload).toBe("off");
    expect(config.security.encryption.at_rest).toBe("off");
    expect(config.security.transport.mtls).toBe("off");
  });

  test("cortex#1000: signing seed + EXPLICIT security.signing: off stays off", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    cfg.security = { signing: "off" };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.security.signing).toBe("off");
  });

  test("cortex#1000: signing seed + security block WITHOUT a signing key → permissive, siblings preserved", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    cfg.security = { encryption: { payload: "opt-in" } };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.security.signing).toBe("permissive");
    expect(config.security.encryption.payload).toBe("opt-in");
  });

  test("cortex#1000: signing seed + explicit enforce untouched by the seed-aware default", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    cfg.security = { signing: "enforce" };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.security.signing).toBe("enforce");
  });

  test("cortex#1000: stack block without nkey_seed_path keeps the off default", () => {
    const cfg = minimalCortex();
    cfg.stack = { id: "jc/research" };
    const { config } = loadConfigWithAgents(writeCortexConfig(testDir, cfg));
    expect(config.security.signing).toBe("off");
  });

  // Sage review on #1020 — a MALFORMED `security:` block must reach the
  // schema parse untouched and fail with the schema's own error; the
  // seed-aware default must never rewrite it into a valid-looking object.
  test("cortex#1000: malformed security (array) is NOT masked by the seed-aware default", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    cfg.security = ["off"];
    expect(() => loadConfigWithAgents(writeCortexConfig(testDir, cfg))).toThrow();
  });

  test("cortex#1000: malformed security (string) is NOT masked by the seed-aware default", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    cfg.security = "off";
    expect(() => loadConfigWithAgents(writeCortexConfig(testDir, cfg))).toThrow();
  });

  test("cortex#1000: bare null security key is NOT masked by the seed-aware default", () => {
    const cfg = minimalCortex();
    cfg.stack = {
      id: "jc/research",
      nkey_seed_path: "~/.config/nats/cortex-research.nk",
    };
    cfg.security = null;
    expect(() => loadConfigWithAgents(writeCortexConfig(testDir, cfg))).toThrow();
  });

  // Sage round 2 on #1020 — non-plain objects (Date, Map, class instances)
  // must not be treated as mergeable records either. These can't round-trip
  // through the YAML fixture (the parser emits plain mappings), so the
  // exported helper is exercised directly.
  test("cortex#1000: applySeedAwareSigningDefault leaves non-plain security objects untouched", () => {
    const seed = { stack: { nkey_seed_path: "~/x.nk" } };
    for (const malformed of [new Date(0), new Map(), new URL("https://example.com")]) {
      const raw: Record<string, unknown> = { ...seed, security: malformed };
      expect(applySeedAwareSigningDefault(raw)).toBe(false);
      expect(raw.security).toBe(malformed); // untouched, schema will reject
    }
  });

  test("cortex#1000: applySeedAwareSigningDefault accepts a null-prototype record", () => {
    const securityRec = Object.create(null) as Record<string, unknown>;
    const raw: Record<string, unknown> = {
      stack: { nkey_seed_path: "~/x.nk" },
      security: securityRec,
    };
    expect(applySeedAwareSigningDefault(raw)).toBe(true);
    expect((raw.security as Record<string, unknown>).signing).toBe("permissive");
  });

  test("passes bus.review provisioning knobs through with defaults applied", () => {
    const cfg = minimalCortex();
    cfg.bus = {
      review: {
        stream: {
          name: "CODE_REVIEW_TEST",
          maxAgeSeconds: 3_600,
          maxBytes: 128 * 1024 * 1024,
        },
        consumer: {
          maxDeliver: 3,
        },
      },
    };
    const path = writeCortexConfig(testDir, cfg);
    const { bus } = loadConfigWithAgents(path);
    expect(bus?.review.stream.name).toBe("CODE_REVIEW_TEST");
    expect(bus?.review.stream.maxAgeSeconds).toBe(3_600);
    expect(bus?.review.stream.maxBytes).toBe(128 * 1024 * 1024);
    expect(bus?.review.consumer.maxDeliver).toBe(3);
  });

  test("legacy shape continues to return empty inlineAgents", () => {
    const configPath = writeCentralConfig(testDir, minimalCentral());
    const loaded = loadConfigWithAgents(configPath);
    expect(loaded.inlineAgents).toEqual([]);
    expect(loaded.config.agent.name).toBeDefined();
  });

  test("loadConfig backward-compat wrapper still returns AgentConfig only", () => {
    const path = writeCortexConfig(testDir, minimalCortex());
    const cfg = loadConfig(path);
    expect(cfg.agent.name).toBe("ivy");
    // Type sanity — no inlineAgents on the AgentConfig
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
    // Falls into the legacy branch; AgentConfigSchema rejects missing agent.name
    expect(() => loadConfigWithAgents(path)).toThrow();
  });

  test("agents-only with no operator falls back to legacy parse (detection requires both)", () => {
    const partial = { agents: [{ id: "ivy" }] };
    const path = writeCortexConfig(testDir, partial);
    expect(() => loadConfigWithAgents(path)).toThrow();
  });

  // cortex#98 (part A) — schema parity: `presence.discord.trustedBotIds`
  // is preserved through the cortex-shape → legacy AgentConfig synthesizer.
  // Before this fix, DiscordPresenceSchema lacked the field entirely and
  // zod's default unknown-key-strip behaviour silently dropped the
  // principal-set value during `CortexConfigSchema.parse`, leaving the
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
  // preserved through the cortex-shape → legacy AgentConfig synthesizer so
  // operators can wire bus-envelope subjects into the Discord adapter's
  // surface-router match set. Before this fix, the field was absent from
  // both DiscordPresenceSchema and DiscordInstanceSchema, so zod's
  // unknown-key-strip silently dropped any principal-set value.
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
    // principal passes a number, schema returns a string of that number.
    // The separate "preserves quoted snowflake string verbatim" test below
    // exercises the realistic path (principal quotes the snowflake in yaml).
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
    // The realistic principal path: yaml configs surrounding `agentChannelId`,
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
    // `deriveStackId` falls through to `${principal.id}/default`.
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
    // AgentConfigSchema has no `stack:` field during the MIG-7.2 overlap
    // window. The legacy branch of `loadConfigWithAgents` must produce a
    // `LoadedConfig` with `stack: undefined` so the boot path's destructure
    // (`const { stack } = ...`) stays safe.
    const configPath = writeCentralConfig(testDir, minimalCentral());
    const loaded = loadConfigWithAgents(configPath);
    expect(loaded.stack).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // v2.0.0 legacy authorisation rejection (PR #310 r1 M-1 fix)
  //
  // Echo PR #310 r1 caught: removing the entire pre-Zod legacy-detection
  // throw block left 109/109 loader tests passing — the loud-error claim
  // was structurally fragile. These tests pin the rejection path so future
  // refactors can't silently regress it.
  // -------------------------------------------------------------------------

  test("v2.0.0 rejects agents[].presence.discord.roles[] with migrate-config pointer", () => {
    const cfg = minimalCortex();
    const agent = (cfg.agents as Record<string, unknown>[])[0]!;
    const presence = agent.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    discord.roles = [
      { name: "operator", users: ["100000000000000999"], features: ["chat"] },
    ];
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(
      /agents\[0\]\.presence\.discord\.roles\[\]/,
    );
    expect(() => loadConfigWithAgents(path)).toThrow(/migrate-config\.ts/);
  });

  test("v2.0.0 rejects agents[].presence.discord.defaultRole", () => {
    const cfg = minimalCortex();
    const agent = (cfg.agents as Record<string, unknown>[])[0]!;
    const presence = agent.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    discord.defaultRole = "denied";
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(
      /agents\[0\]\.presence\.discord\.defaultRole/,
    );
    expect(() => loadConfigWithAgents(path)).toThrow(/migrate-config\.ts/);
  });

  test("v2.0.0 rejects agents[].presence.discord.dm block", () => {
    const cfg = minimalCortex();
    const agent = (cfg.agents as Record<string, unknown>[])[0]!;
    const presence = agent.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    discord.dm = { operatorRole: { features: ["chat"] } };
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(
      /agents\[0\]\.presence\.discord\.dm/,
    );
    expect(() => loadConfigWithAgents(path)).toThrow(/migrate-config\.ts/);
  });

  test("v2.0.0 rejects agents[].roles[] (legacy top-level agent-roles field)", () => {
    const cfg = minimalCortex();
    const agent = (cfg.agents as Record<string, unknown>[])[0]!;
    agent.roles = [{ name: "operator", users: ["100000000000000999"] }];
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(/agents\[0\]\.roles\[\]/);
    expect(() => loadConfigWithAgents(path)).toThrow(/migrate-config\.ts/);
  });

  test("v2.0.0 rejects policy.parallel_mode_enabled (retired with cortex#296 parallel-mode plumbing)", () => {
    const cfg = minimalCortex();
    cfg.policy = {
      principals: [],
      roles: [],
      parallel_mode_enabled: false,
    };
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow(/policy\.parallel_mode_enabled/);
    expect(() => loadConfigWithAgents(path)).toThrow(/migrate-config\.ts/);
  });

  test("v2.0.0 lists every offender in a single error message", () => {
    // Multi-offender case: principal left BOTH presence.discord.roles[] AND
    // presence.discord.dm in the file. The error should enumerate both so
    // they can fix everything in one migrate-config run.
    const cfg = minimalCortex();
    const agent = (cfg.agents as Record<string, unknown>[])[0]!;
    const presence = agent.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    discord.roles = [{ name: "user", users: ["111"], features: ["chat"] }];
    discord.dm = { operatorRole: { features: ["chat"] } };
    const path = writeCortexConfig(testDir, cfg);
    try {
      loadConfigWithAgents(path);
      throw new Error("expected loadConfigWithAgents to throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("agents[0].presence.discord.roles[]");
      expect(msg).toContain("agents[0].presence.discord.dm");
      expect(msg).toContain("migrate-config.ts");
    }
  });

  test("v2.0.0 accepts a clean cortex.yaml with no legacy fields", () => {
    // Positive case — minimal cortex-shape with no auth fields parses OK.
    const path = writeCortexConfig(testDir, minimalCortex());
    expect(() => loadConfigWithAgents(path)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // R3 vocabulary migration (cortex#388) — `operator:` → `principal:`
  //
  // The transition release accepts BOTH a legacy `operator:` block and the
  // new `principal:` block (prefer `principal:`). A config carrying BOTH is
  // a deployment-config trust boundary and is rejected with a typed
  // `dual_field_conflict` BEFORE any membership / capability decision. The
  // `operator:` reader removal is the future breaking PR-11 / v3.0.0.
  // ---------------------------------------------------------------------------

  /** minimalCortex() keyed by `principal:` (v3.0.0 BREAKING — manifest PR-11). */
  function minimalCortexPrincipalShape(): Record<string, unknown> {
    return minimalCortex();
  }

  test("R3 — loads a `principal:`-shaped cortex.yaml (new canonical key)", () => {
    const path = writeCortexConfig(testDir, minimalCortexPrincipalShape());
    const loaded = loadConfigWithAgents(path);
    expect(loaded.inlineAgents).toHaveLength(1);
    expect(loaded.inlineAgents[0]!.id).toBe("ivy");
    // The principal block is normalised onto LoadedConfig.principal.
    // cortex#429 PR-C — `config.agent.operatorId` retired; principal id
    // is sole-sourced from `LoadedConfig.principal.id` now.
    expect(loaded.principal?.id).toBe("jc");
    expect(loaded.principal?.discordId).toBe("285727653603049472");
  });

  // v4.0.0 BREAKING CUT — cortex.yaml requires the canonical `principal:`
  // key. The legacy top-level `operator:` block reader is GONE, and with it
  // the transition-era dual-block guard (`DualBlockConflictError`): there is
  // no longer an `operator:` reader for a `principal:` block to be ambiguous
  // against. A stray `operator:` key is now just an unrecognised top-level
  // key — ignored when the config is otherwise cortex-shape, and a steer
  // toward `cortex migrate-config` when an `operator:`-only config falls
  // through to the legacy bot.yaml path.

  test("v4 BREAKING — a `principal:`-shaped config with a stray `operator:` key still loads (operator block ignored)", () => {
    // No dual-block conflict at v4: the `operator:` reader was removed, so
    // the leftover key is inert. The principal id is sole-sourced from the
    // canonical `principal:` block.
    const cfg = minimalCortexPrincipalShape();
    cfg.operator = { id: "someone-else", discordId: "999" };
    const path = writeCortexConfig(testDir, cfg);

    const loaded = loadConfigWithAgents(path);
    expect(loaded.inlineAgents).toHaveLength(1);
    // The canonical principal wins; the legacy `operator:` block does not
    // override or shadow it.
    expect(loaded.principal?.id).toBe("jc");
  });

  test("v4 BREAKING — a legacy `operator:`-only cortex.yaml no longer loads as cortex-shape", () => {
    // Pre-v4 this might have resolved via the `operator:` reader. With the
    // reader gone, an `operator:`-block-only config is NOT cortex-shape
    // (no canonical `principal:` block), so it falls through to the legacy
    // bot.yaml path — where, lacking any valid bot.yaml fields, it is
    // rejected. The principal must run `cortex migrate-config`.
    const cfg: Record<string, unknown> = {
      operator: { id: "jc" },
      agents: minimalCortex().agents,
    };
    const path = writeCortexConfig(testDir, cfg);
    expect(() => loadConfigWithAgents(path)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TC-4a (cortex#636) — chmod-600 gate on the single-file cortex.yaml read.
//
// The single `cortex.yaml` carries platform BOT TOKENS (Discord/Slack/
// Mattermost) inline, so the single-file load path enforces the same
// chmod-600 gate the nkey-seed and `.creds` loaders already apply. The gate
// is POSIX-only (the shared helper skips win32, where NTFS uses ACLs).
// ---------------------------------------------------------------------------

describe("TC-4a — chmod-600 gate on single-file cortex.yaml (cortex#636)", () => {
  // Minimal valid cortex-shape config (mirrors the MIG-7.2e fixtures) — its
  // own copy so this block is independent of the cortex-shape describe scope.
  function minimalCortexConfig(): Record<string, unknown> {
    return {
      principal: { id: "jc", displayName: "JC", discordId: "1" },
      agents: [
        {
          id: "ivy",
          displayName: "Ivy",
          persona: "./personas/ivy.md",
          roles: [],
          trust: [],
          presence: {
            discord: {
              token: "fake-token-ivy",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
      claude: {},
    };
  }

  // The gate is a no-op on win32 (NTFS ACLs are the principal's
  // responsibility — see file-permissions.ts), so skip there.
  const itPosix = process.platform === "win32" ? test.skip : test;

  itPosix("rejects a cortex.yaml with looser-than-0600 perms", () => {
    const path = join(testDir, "cortex.yaml");
    writeFileSync(path, stringify(minimalCortexConfig()));
    chmodSync(path, 0o644); // group/world-readable — must be rejected
    expect(() => loadConfigWithAgents(path)).toThrow(/must be chmod 600/);
  });

  itPosix("rejects a group/world-writable cortex.yaml (0660)", () => {
    const path = join(testDir, "cortex.yaml");
    writeFileSync(path, stringify(minimalCortexConfig()));
    chmodSync(path, 0o660);
    expect(() => loadConfigWithAgents(path)).toThrow(/must be chmod 600/);
  });

  itPosix("loads a cortex.yaml that is exactly chmod 600", () => {
    const path = join(testDir, "cortex.yaml");
    writeFileSync(path, stringify(minimalCortexConfig()));
    chmodSync(path, 0o600);
    const loaded = loadConfigWithAgents(path);
    expect(loaded.inlineAgents).toHaveLength(1);
    expect(loaded.principal?.id).toBe("jc");
  });
});

// =============================================================================
// S1 (cortex#1159) — per-agent Discord/Mattermost adapters from agents.d
// fragments. The flatten helpers are now exported so the cortex.ts boot path
// can re-run them over the fragment-only agents and APPEND the result to the
// adapter-construction instance lists (`config.discord` carries inline presence
// only). These tests pin (a) the helpers' agent→flat-instance mapping +
// instanceId convention + enabled passthrough, and (b) the exact boot-path
// append logic — inline ∪ fragment-only, fragments shadowed by inline ids
// filtered out so a both-inline-and-fragment agent appears once.
// =============================================================================
describe("S1 (cortex#1159) — exported presence-flatten helpers + boot-path append", () => {
  function fragmentAgent(
    id: string,
    presence: Record<string, unknown>,
  ): Agent {
    return AgentSchema.parse({
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      persona: `./personas/${id}.md`,
      trust: [],
      presence,
    });
  }

  const discordPresence = (over: Record<string, unknown> = {}) => ({
    discord: {
      token: `tok-${Math.random().toString(36).slice(2)}`,
      guildId: "1487023327791808592",
      agentChannelId: "1487029848164536361",
      logChannelId: "1487029942129524786",
      ...over,
    },
  });

  const mattermostPresence = (over: Record<string, unknown> = {}) => ({
    mattermost: {
      apiUrl: "https://mm.example.com",
      apiToken: `mm-${Math.random().toString(36).slice(2)}`,
      channels: ["town-square"],
      ...over,
    },
  });

  test("a fragment Discord agent flattens to an instance bound to the fragment's identity", () => {
    const persona = "./personas/pier.md";
    const pier = AgentSchema.parse({
      id: "pier",
      displayName: "Pier",
      persona,
      trust: ["luna"],
      presence: discordPresence({ token: "pier-token" }),
    });
    const flat = flattenDiscordPresences([pier]);
    expect(flat).toHaveLength(1);
    // instanceId follows the `${agent.id}-discord` convention — the same key
    // `agentByDiscordToken` (built from mergedAgents at boot) uses to bind the
    // constructed adapter back to the fragment's full Agent (id/persona/trust).
    expect(flat[0]!.instanceId).toBe("pier-discord");
    expect(flat[0]!.token).toBe("pier-token");
    // The fragment carries its own identity; the boot loop's
    // `agentByDiscordToken.get(instance.token)` resolves to THIS agent.
    expect(pier.id).toBe("pier");
    expect(pier.displayName).toBe("Pier");
    expect(pier.persona).toBe(persona);
    expect(pier.trust).toEqual(["luna"]);
  });

  test("a fragment Mattermost agent flattens to a mattermost instance", () => {
    const ivy = fragmentAgent("ivy", mattermostPresence({ apiToken: "ivy-mm" }));
    const flat = flattenMattermostPresences([ivy]);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.instanceId).toBe("ivy-mattermost");
    expect(flat[0]!.apiToken).toBe("ivy-mm");
  });

  test("a disabled fragment presence is still flattened (carries enabled:false); the boot loop's own skip applies", () => {
    // The flatten helper does NOT filter on `enabled` — it mirrors the inline
    // path, which also flattens disabled presences and lets the adapter loop's
    // `if (!instance.enabled) continue` do the skip. The instance must therefore
    // appear in the flattened list, carrying enabled:false.
    const dim = fragmentAgent("dim", discordPresence({ enabled: false, token: "dim-tok" }));
    const flat = flattenDiscordPresences([dim]);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.enabled).toBe(false);
    expect(flat[0]!.instanceId).toBe("dim-discord");
  });

  test("an agent with no presence block contributes no instance", () => {
    const headless = fragmentAgent("headless", {});
    expect(flattenDiscordPresences([headless])).toHaveLength(0);
    expect(flattenMattermostPresences([headless])).toHaveLength(0);
    expect(flattenSlackPresences([headless])).toHaveLength(0);
  });

  // The exact boot-path computation from src/cortex.ts: the adapter loops
  // iterate `[...config.discord, ...flattenDiscordPresences(fragmentOnlyAgents)]`,
  // where `fragmentOnlyAgents = fragmentAgents.filter(a => !inlineIds.has(a.id))`.
  function bootDiscordInstances(
    inlineFlat: readonly { instanceId?: string; token: string }[],
    fragmentAgents: readonly Agent[],
    inlineAgents: readonly Agent[],
  ) {
    const inlineIds = new Set(inlineAgents.map((a) => a.id));
    const fragmentOnlyAgents = fragmentAgents.filter((a) => !inlineIds.has(a.id));
    return [...inlineFlat, ...flattenDiscordPresences(fragmentOnlyAgents)];
  }

  test("inline-only stack: instance list is unchanged (regression — no fragments appended)", () => {
    const inlineAgent = fragmentAgent("luna", discordPresence({ token: "luna-inline" }));
    const inlineFlat = flattenDiscordPresences([inlineAgent]);
    // No fragments present → append nothing → byte-identical to the inline list.
    const instances = bootDiscordInstances(inlineFlat, [], [inlineAgent]);
    expect(instances).toEqual(inlineFlat);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.token).toBe("luna-inline");
  });

  test("fragment-only Discord agent is appended to the boot instance list", () => {
    const inlineAgent = fragmentAgent("luna", discordPresence({ token: "luna-inline" }));
    const inlineFlat = flattenDiscordPresences([inlineAgent]);
    const pierFragment = fragmentAgent("pier", discordPresence({ token: "pier-frag" }));
    const instances = bootDiscordInstances(inlineFlat, [pierFragment], [inlineAgent]);
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.instanceId)).toEqual(["luna-discord", "pier-discord"]);
    expect(instances[1]!.token).toBe("pier-frag");
  });

  test("an agent that is BOTH inline and a fragment (same id) appears once — inline wins, fragment shadowed", () => {
    // Inline luna + a fragment ALSO named luna. The fragment is shadowed (its id
    // is in inlineIds), so fragmentOnlyAgents excludes it → no duplicate instance.
    const inlineLuna = fragmentAgent("luna", discordPresence({ token: "luna-inline" }));
    const inlineFlat = flattenDiscordPresences([inlineLuna]);
    const fragmentLuna = fragmentAgent("luna", discordPresence({ token: "luna-fragment" }));
    const instances = bootDiscordInstances(inlineFlat, [fragmentLuna], [inlineLuna]);
    expect(instances).toHaveLength(1);
    // Inline's token survives; the shadowed fragment's token never enters.
    expect(instances[0]!.token).toBe("luna-inline");
    expect(instances.some((i) => i.token === "luna-fragment")).toBe(false);
  });
});
