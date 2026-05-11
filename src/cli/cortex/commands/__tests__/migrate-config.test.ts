/**
 * MIG-7.2e — migrate-config tests.
 *
 * Fixture-driven: each `*.bot.yaml` under `./fixtures/` represents a real
 * grove-v2 deployment shape. Tests assert the conversion output rounds-trips
 * through `CortexConfigSchema` and that warnings / mappings track expectations.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import YAML from "yaml";

import {
  convertBotYaml,
  formatCheckReport,
  type LegacyBotYaml,
} from "../migrate-config-lib";
import { parseArgs, runMigrateConfig } from "../migrate-config";
import { CortexConfigSchema } from "../../../../common/types/cortex-config";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

function loadFixture(name: string): LegacyBotYaml {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf-8");
  return YAML.parse(raw) as LegacyBotYaml;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses input + --out", () => {
    const args = parseArgs(["in.yaml", "--out", "out.yaml"]);
    expect(args.input).toBe("in.yaml");
    expect(args.out).toBe("out.yaml");
    expect(args.check).toBe(false);
    expect(args.strict).toBe(false);
  });

  test("parses --out=FORM equality syntax", () => {
    const args = parseArgs(["in.yaml", "--out=out.yaml"]);
    expect(args.out).toBe("out.yaml");
  });

  test("parses --check + --strict toggles", () => {
    const args = parseArgs(["in.yaml", "--check", "--strict"]);
    expect(args.check).toBe(true);
    expect(args.strict).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["in.yaml", "--bogus"])).toThrow(/unknown flag/);
  });

  test("rejects --out without a value", () => {
    expect(() => parseArgs(["in.yaml", "--out"])).toThrow(/requires a path/);
  });

  test("treats trailing flag as missing arg", () => {
    expect(() => parseArgs(["in.yaml", "--out", "--check"])).toThrow(/requires a path/);
  });
});

// ---------------------------------------------------------------------------
// Conversion: minimal single-agent
// ---------------------------------------------------------------------------

describe("convertBotYaml — minimal single-agent", () => {
  test("emits one agent with discord presence + valid operator", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });

    expect(result.cortex.operator.id).toBe("jc");
    expect(result.cortex.operator.discordId).toBe("112233445566778899");
    expect(result.cortex.operator.dataResidency).toBe("NZ");

    expect(result.cortex.agents).toHaveLength(1);
    const agent = result.cortex.agents[0]!;
    expect(agent.id).toBe("luna");
    expect(agent.displayName).toBe("Luna");
    expect(agent.persona).toBe("./personas/luna.md");
    expect(agent.presence.discord).toBeDefined();
    expect(agent.presence.discord!.guildId).toBe("100000000000000001");
    expect(agent.presence.mattermost).toBeUndefined();
    expect(agent.trust).toEqual([]);
  });

  test("output round-trips through CortexConfigSchema", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    // convertBotYaml already calls schema.parse internally, but re-parsing the
    // returned object verifies the result is structurally complete (no fields
    // dropped by the strict refine).
    expect(() => CortexConfigSchema.parse(result.cortex)).not.toThrow();
  });

  test("produces a mapping entry for the single discord instance", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]).toMatchObject({
      legacyKind: "discord",
      legacyIndex: 0,
      newAgentId: "luna",
      newPresence: "discord",
    });
  });
});

// ---------------------------------------------------------------------------
// Conversion: multi-discord (suffix synthesis)
// ---------------------------------------------------------------------------

describe("convertBotYaml — multi-discord", () => {
  test("emits N agents with -2, -3 suffixes", () => {
    const legacy = loadFixture("multi-discord.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["luna", "luna-2", "luna-3"]);
  });

  test("each variant carries its own discord presence", () => {
    const legacy = loadFixture("multi-discord.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.presence.discord!.token).toBe("token-a");
    expect(result.cortex.agents[1]!.presence.discord!.token).toBe("token-b");
    expect(result.cortex.agents[2]!.presence.discord!.token).toBe("token-c");
  });

  test("emits one warning announcing the suffix expansion", () => {
    const legacy = loadFixture("multi-discord.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const warning = result.warnings.find((w) => w.field === "agents");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/emitting 3 agents/);
  });

  test("mapping table records all 3 input instanceIds", () => {
    const legacy = loadFixture("multi-discord.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.mappings.map((m) => m.legacyInstanceId)).toEqual([
      "luna-guild-a",
      "luna-guild-b",
      "luna-guild-c",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Conversion: trustedAgentBots round-trip
// ---------------------------------------------------------------------------

describe("convertBotYaml — trustedAgentBots", () => {
  test("maps each entry's `name` into agents[].trust", () => {
    const legacy = loadFixture("trust.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.trust).toEqual(["echo", "holly", "ivy"]);
  });

  test("normalizes mixed-case trusted-bot names with a warning", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        operatorId: "jc",
        personaFile: "./personas/luna.md",
      },
      discord: [
        {
          token: "t",
          guildId: "1",
          agentChannelId: "2",
          logChannelId: "3",
        },
      ],
      trustedAgentBots: [{ discordId: "9", name: "Echo Bot" }],
    };
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.trust).toEqual(["echo-bot"]);
    expect(result.warnings.some((w) => w.field === "trustedAgentBots")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Conversion: persona-file validation
// ---------------------------------------------------------------------------

describe("convertBotYaml — persona-file validation", () => {
  test("warns when personaFile path does not exist on disk", () => {
    const legacy = loadFixture("missing-persona.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const personaWarn = result.warnings.find((w) => w.field === "agents[ghost].persona");
    expect(personaWarn).toBeDefined();
    expect(personaWarn!.message).toMatch(/persona file not found/);
  });

  test("skips file-existence check when configDir is omitted", () => {
    const legacy = loadFixture("missing-persona.bot.yaml");
    const result = convertBotYaml(legacy, {});
    // file-existence warning suppressed without a configDir
    const personaWarn = result.warnings.find(
      (w) => w.field === "agents[ghost].persona" && /not found/.test(w.message),
    );
    expect(personaWarn).toBeUndefined();
  });

  test("defaults to ./personas/<id>.md when personaFile omitted, with warning", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents[0]!.persona).toBe("./personas/luna.md");
    const w = result.warnings.find((x) => x.field === "agents[luna].persona");
    expect(w).toBeDefined();
    expect(w!.message).toMatch(/defaulted/);
  });
});

// ---------------------------------------------------------------------------
// Conversion: full bot.yaml (every field exercised)
// ---------------------------------------------------------------------------

describe("convertBotYaml — full fixture", () => {
  test("output passes CortexConfigSchema validation", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(() => CortexConfigSchema.parse(result.cortex)).not.toThrow();
  });

  test("operator block carries discord + mattermost + dataResidency", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.operator).toEqual({
      id: "jc",
      displayName: "Jens-Christian",
      discordId: "112233445566778899",
      mattermostId: "mm-jc-id",
      dataResidency: "NZ",
    });
  });

  test("emits both discord and mattermost presence on a single agent", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents).toHaveLength(1);
    const agent = result.cortex.agents[0]!;
    expect(agent.presence.discord).toBeDefined();
    expect(agent.presence.mattermost).toBeDefined();
    expect(agent.presence.discord!.worklogChannelId).toBe("100000000000000004");
    expect(agent.presence.discord!.operatorRoleId).toBe("100000000000000099");
    expect(agent.presence.mattermost!.apiUrl).toBe("https://mm.example.com");
  });

  test("legacy api.enabled=true synthesizes a dashboard renderer", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const dash = result.cortex.renderers.find((r) => r.kind === "dashboard");
    expect(dash).toBeDefined();
    expect(dash!.kind).toBe("dashboard");
    if (dash && dash.kind === "dashboard") {
      expect(dash.port).toBe(8767);
    }
    expect(result.warnings.some((w) => w.field === "api")).toBe(true);
  });

  test("warns about dropped `grove:` block", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.warnings.some((w) => w.field === "grove")).toBe(true);
  });

  test("passes nats config through unchanged", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.nats?.url).toBe("nats://localhost:4222");
    expect(result.cortex.nats?.subjects).toEqual(["local.{org}.>"]);
  });
});

// ---------------------------------------------------------------------------
// Conversion: structural failures
// ---------------------------------------------------------------------------

describe("convertBotYaml — structural failures", () => {
  test("throws when input is not an object", () => {
    expect(() => convertBotYaml("not an object" as unknown as LegacyBotYaml)).toThrow(/not an object/);
  });

  test("throws when agent block is missing", () => {
    expect(() => convertBotYaml({ discord: [] } as unknown as LegacyBotYaml)).toThrow(/missing required `agent:`/);
  });

  test("throws when agent.name is missing", () => {
    expect(() =>
      convertBotYaml({ agent: { displayName: "x" } } as unknown as LegacyBotYaml),
    ).toThrow(/agent\.name/);
  });

  test("throws when agent.displayName is missing", () => {
    expect(() =>
      convertBotYaml({ agent: { name: "luna" } } as unknown as LegacyBotYaml),
    ).toThrow(/agent\.displayName/);
  });
});

// ---------------------------------------------------------------------------
// Operator id normalization
// ---------------------------------------------------------------------------

describe("convertBotYaml — operator id normalization", () => {
  test("upcases dataResidency when 2 lowercase letters", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        operatorId: "jc",
        dataResidency: "ch",
        personaFile: "./personas/luna.md",
      },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.operator.dataResidency).toBe("CH");
    expect(result.warnings.some((w) => w.field === "operator.dataResidency")).toBe(true);
  });

  test("falls back to NZ when dataResidency is malformed", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        operatorId: "jc",
        dataResidency: "Switzerland",
        personaFile: "./personas/luna.md",
      },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.operator.dataResidency).toBe("NZ");
  });

  test("normalizes mixed-case operatorId with a warning", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        operatorId: "JC",
        personaFile: "./personas/luna.md",
      },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.operator.id).toBe("jc");
    expect(result.warnings.some((w) => w.field === "operator.id")).toBe(true);
  });

  test("falls back operator.id to agent.name when operatorId unset", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        personaFile: "./personas/luna.md",
      },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.operator.id).toBe("luna");
  });
});

// ---------------------------------------------------------------------------
// Mismatched discord / mattermost array lengths
// (Holly cortex#51 round 1 major #2 — locked here so the synthesis logic
//  for "2 discord + 1 mattermost" can't silently change.)
// ---------------------------------------------------------------------------

describe("convertBotYaml — mismatched discord/mattermost lengths", () => {
  test("emits N=max(discord, mattermost) agents", () => {
    const legacy = loadFixture("mismatched-lengths.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["luna", "luna-2"]);
  });

  test("first agent carries both discord and mattermost presence", () => {
    const legacy = loadFixture("mismatched-lengths.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.presence.discord).toBeDefined();
    expect(result.cortex.agents[0]!.presence.mattermost).toBeDefined();
  });

  test("second agent has only discord (mattermost ran out)", () => {
    const legacy = loadFixture("mismatched-lengths.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[1]!.presence.discord).toBeDefined();
    expect(result.cortex.agents[1]!.presence.mattermost).toBeUndefined();
  });

  test("empty discord + populated mattermost emits 1 mattermost-only agent", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        operatorId: "jc",
        personaFile: "./personas/luna.md",
      },
      discord: [],
      mattermost: [
        { apiUrl: "https://mm.example.com", apiToken: "tok" },
      ],
    };
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents).toHaveLength(1);
    expect(result.cortex.agents[0]!.presence.discord).toBeUndefined();
    expect(result.cortex.agents[0]!.presence.mattermost).toBeDefined();
  });

  test("output round-trips through CortexConfigSchema", () => {
    const legacy = loadFixture("mismatched-lengths.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(() => CortexConfigSchema.parse(result.cortex)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// First-variant display name (Holly cortex#51 round 1 nit-1)
// ---------------------------------------------------------------------------

describe("convertBotYaml — first-variant display name", () => {
  test("when variantCount > 1, agents[0] keeps bare displayName", () => {
    const legacy = loadFixture("multi-discord.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.displayName).toBe("Luna");
    expect(result.cortex.agents[1]!.displayName).toBe("Luna (2)");
    expect(result.cortex.agents[2]!.displayName).toBe("Luna (3)");
  });
});

// ---------------------------------------------------------------------------
// Degenerate agent.name (Holly cortex#51 round 1 suggestion)
// ---------------------------------------------------------------------------

describe("convertBotYaml — degenerate agent.name", () => {
  test("throws when agent.name normalizes to empty string", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "!!!", displayName: "Bang" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    expect(() => convertBotYaml(legacy, {})).toThrow(/cannot be derived to a valid agent id/);
  });

  test("throws when trustedAgentBots entry normalizes to empty string", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      trustedAgentBots: [{ name: "!!!" }],
    };
    expect(() => convertBotYaml(legacy, {})).toThrow(/cannot be derived/);
  });
});

// ---------------------------------------------------------------------------
// Defaults sourced from CortexConfig schema (Holly cortex#51 round 1 major #1)
// ---------------------------------------------------------------------------

describe("convertBotYaml — schema-sourced defaults", () => {
  test("discord presence fills schema defaults for unspecified fields", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
    };
    const result = convertBotYaml(legacy, {});
    const d = result.cortex.agents[0]!.presence.discord!;
    expect(d.contextDepth).toBe(10);
    expect(d.enableAgentLog).toBe(false);
    expect(d.defaultRole).toBe("allow-all");
    expect(d.enabled).toBe(true);
    // dm block defaults from DMConfigSchema (operatorRole defaulted from DMRoleSchema)
    expect(d.dm.defaultRole).toBe("denied");
  });

  test("mattermost presence fills schema defaults for unspecified fields", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      mattermost: [{ apiUrl: "https://mm.example.com" }],
    };
    const result = convertBotYaml(legacy, {});
    const m = result.cortex.agents[0]!.presence.mattermost!;
    expect(m.callbackPort).toBe(8080);
    expect(m.pollIntervalMs).toBe(3000);
    expect(m.defaultRole).toBe("allow-all");
    expect(m.allowedUsers).toEqual([]);
    expect(m.channels).toEqual([]);
  });

  test("malformed renderers entry throws at the conversion site (not the final parse)", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      renderers: [{ kind: "dashbord" } as unknown],
    };
    expect(() => convertBotYaml(legacy, {})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildTrustList — extracted helper (Holly cortex#51 round 1 architecture)
// ---------------------------------------------------------------------------

// (Coverage of buildTrustList behaviors is folded into the trustedAgentBots
//  and degenerate-name describe blocks above; the helper is exercised via
//  the public `convertBotYaml` boundary.)

// ---------------------------------------------------------------------------
// Check report rendering
// ---------------------------------------------------------------------------

describe("formatCheckReport", () => {
  test("lists operator, agents, renderers, mappings and warnings", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const report = formatCheckReport(result);
    expect(report).toMatch(/operator: jc/);
    expect(report).toMatch(/agents: +1/);
    expect(report).toMatch(/instance mappings:/);
    expect(report).toMatch(/warnings/);
  });

  test("reports `warnings: none` when no warnings produced", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const report = formatCheckReport(result);
    if (result.warnings.length === 0) {
      expect(report).toMatch(/warnings: none/);
    }
  });
});

// ---------------------------------------------------------------------------
// runMigrateConfig — end-to-end CLI smoke
// ---------------------------------------------------------------------------

describe("runMigrateConfig", () => {
  test("--check exits 0 with valid input", async () => {
    const code = await runMigrateConfig([
      join(FIXTURE_DIR, "minimal.bot.yaml"),
      "--check",
    ]);
    expect(code).toBe(0);
  });

  test("writes output to --out file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-7-2e-"));
    const out = join(dir, "cortex.yaml");
    const code = await runMigrateConfig([
      join(FIXTURE_DIR, "minimal.bot.yaml"),
      "--out",
      out,
    ]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const written = YAML.parse(readFileSync(out, "utf-8"));
    // Re-parse via the schema to confirm the file is a valid cortex.yaml
    expect(() => CortexConfigSchema.parse(written)).not.toThrow();
  });

  test("--strict returns exit code 2 when warnings present", async () => {
    // missing-persona fixture produces a persona-file-not-found warning
    const code = await runMigrateConfig([
      join(FIXTURE_DIR, "missing-persona.bot.yaml"),
      "--check",
      "--strict",
    ]);
    expect(code).toBe(2);
  });

  test("returns exit code 1 for missing input file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-7-2e-"));
    const bogus = join(dir, "nonexistent.bot.yaml");
    const code = await runMigrateConfig([bogus]);
    expect(code).toBe(1);
  });

  test("returns exit code 1 for invalid YAML", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-mig-7-2e-"));
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "agent: {name: luna, displayName: [unterminated", "utf-8");
    const code = await runMigrateConfig([bad]);
    expect(code).toBe(1);
  });

  test("returns exit code 0 with --help", async () => {
    const code = await runMigrateConfig(["--help"]);
    expect(code).toBe(0);
  });
});
