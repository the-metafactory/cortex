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
  type MigratedCortexConfig,
} from "../migrate-config-lib";
import { parseArgs, runMigrateConfig } from "../migrate-config";
import { CortexConfigSchema } from "../../../../common/types/cortex-config";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

function loadFixture(name: string): LegacyBotYaml {
  const raw = readFileSync(join(FIXTURE_DIR, name), "utf-8");
  return YAML.parse(raw) as LegacyBotYaml;
}

/**
 * R3 vocabulary migration (cortex#388) — `convertBotYaml` emits a
 * `principal:`-keyed cortex.yaml. `CortexConfigSchema` still keys the block
 * `operator:` during the transition release (the breaking flip is manifest
 * PR-11 / v3.0.0). The cortex loader normalises `principal:` → `operator:`
 * before its `CortexConfigSchema.parse`; this test helper mirrors that
 * normalisation so round-trip "output validates against the schema" tests
 * exercise the same path.
 */
function asSchemaShape(
  migrated: MigratedCortexConfig | Record<string, unknown>,
): Record<string, unknown> {
  // v3.0.0 BREAKING (manifest PR-11) — `CortexConfigSchema` now keys the
  // top-level block as `principal:` directly. `MigratedCortexConfig === CortexConfig`
  // and the migrated value passes through unchanged; the helper is kept
  // as a thin identity wrapper so the test surface still flows through it
  // (future schema re-keys touch one helper rather than every assertion).
  return migrated;
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

    expect(result.cortex.principal.id).toBe("jc");
    expect(result.cortex.principal.discordId).toBe("112233445566778899");
    expect(result.cortex.principal.dataResidency).toBe("NZ");

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
    expect(() => CortexConfigSchema.parse(asSchemaShape(result.cortex))).not.toThrow();
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

  // Production grove-v2 shape carries trustedAgentBots entries with `id:`
  // (Discord snowflake) + `role:` and no symbolic `name:`. The migrator now
  // skips those with a warning that surfaces the platform id so the operator
  // can hand-map post-migration. Previously this path crashed with
  // `undefined is not an object (evaluating 'legacyName.trim')`.
  test("skips entries missing `name` with a warning naming the Discord id", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      trustedAgentBots: [
        // production shape — id + role only, no symbolic name
        { id: "1487180524542890144", role: "agent-restricted" },
      ],
    };
    const result = convertBotYaml(legacy);
    expect(result.cortex.agents[0]!.trust).toEqual([]);
    const warn = result.warnings.find((w) => w.field === "trustedAgentBots");
    expect(warn).toBeDefined();
    expect(warn!.message).toMatch(/missing symbolic `name`/);
    expect(warn!.message).toMatch(/1487180524542890144/);
    expect(warn!.message).toMatch(/role="agent-restricted"/);
  });

  test("falls back to `discordId` field in the warning when `id` is absent", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      trustedAgentBots: [
        { discordId: "9999", role: "agent-restricted" },
      ],
    };
    const result = convertBotYaml(legacy);
    expect(result.cortex.agents[0]!.trust).toEqual([]);
    expect(result.warnings.find((w) => w.field === "trustedAgentBots")!.message).toMatch(/9999/);
  });

  test("mixed list — keeps named entries, skips id-only ones, ordering preserved", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      trustedAgentBots: [
        { name: "luna" },
        { id: "abc", role: "agent-restricted" },
        { name: "holly" },
        { id: "def" },
      ],
    };
    const result = convertBotYaml(legacy);
    expect(result.cortex.agents[0]!.trust).toEqual(["luna", "holly"]);
    const trustWarnings = result.warnings.filter((w) => w.field === "trustedAgentBots");
    expect(trustWarnings).toHaveLength(2);
    expect(trustWarnings[0]!.message).toMatch(/trustedAgentBots\[1\]/);
    expect(trustWarnings[1]!.message).toMatch(/trustedAgentBots\[3\]/);
  });

  test("empty `name` string still triggers skip-with-warning, not silent acceptance", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      trustedAgentBots: [{ id: "xyz", name: "   " }],
    };
    const result = convertBotYaml(legacy);
    expect(result.cortex.agents[0]!.trust).toEqual([]);
    expect(result.warnings.find((w) => w.field === "trustedAgentBots")!.message)
      .toMatch(/missing symbolic `name`/);
  });
});

// ---------------------------------------------------------------------------
// Conversion: nats.identity shape divergence
// ---------------------------------------------------------------------------

describe("convertBotYaml — nats.identity shape divergence", () => {
  // Real production grove-v2 bot.yaml ships nats.identity in `{did, keyPath}`
  // shape; cortex schema requires `{seedPath, publicKey}`. The migrator
  // strips the block + warns rather than crashing inside CortexConfigSchema.parse.
  test("strips legacy {did, keyPath} identity with a warning carrying the derive hint", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      nats: {
        url: "nats://127.0.0.1:4222",
        identity: { did: "did:mf:jc-ivy", keyPath: "~/.config/metafactory/keys/jc-ivy.key" },
      },
    };
    const result = convertBotYaml(legacy);
    // identity stripped from cortex output
    expect(((result.cortex.nats as Record<string, unknown> | undefined)?.identity)).toBeUndefined();
    // rest of nats survives
    expect((result.cortex.nats as Record<string, unknown> | undefined)?.url).toBe("nats://127.0.0.1:4222");
    const warn = result.warnings.find((w) => w.field === "nats.identity");
    expect(warn).toBeDefined();
    expect(warn!.message).toMatch(/keys: did, keyPath/);
    expect(warn!.message).toMatch(/did=did:mf:jc-ivy/);
    expect(warn!.message).toMatch(/nkeys -inkey/);
    expect(warn!.message).toMatch(/jc-ivy\.key/);
  });

  test("passes through cortex-shaped {seedPath, publicKey} identity unchanged (no warning)", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      nats: {
        url: "nats://127.0.0.1:4222",
        identity: {
          seedPath: "/path/to/seed.nk",
          publicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    };
    const result = convertBotYaml(legacy);
    const identity = (result.cortex.nats as Record<string, unknown> | undefined)?.identity as Record<string, unknown> | undefined;
    expect(identity?.seedPath).toBe("/path/to/seed.nk");
    expect(identity?.publicKey).toBe("UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(result.warnings.find((w) => w.field === "nats.identity")).toBeUndefined();
  });

  test("missing identity block — nats survives, no warning", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      nats: { url: "nats://127.0.0.1:4222" },
    };
    const result = convertBotYaml(legacy);
    expect((result.cortex.nats as Record<string, unknown> | undefined)?.url).toBe("nats://127.0.0.1:4222");
    expect(result.warnings.find((w) => w.field === "nats.identity")).toBeUndefined();
  });

  test("warning omits the derive hint when keyPath is also missing", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "ivy", displayName: "Ivy", operatorId: "jc" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      // identity exists but is structurally garbage — no recoverable seed path
      nats: { url: "nats://127.0.0.1:4222", identity: { weirdField: 42 } },
    };
    const result = convertBotYaml(legacy);
    const warn = result.warnings.find((w) => w.field === "nats.identity");
    expect(warn).toBeDefined();
    expect(warn!.message).toMatch(/once you have an NKey seed/);
    expect(warn!.message).not.toMatch(/nkeys -inkey/);
  });
});

// ---------------------------------------------------------------------------
// Conversion: assistant-prompt-file validation
// ---------------------------------------------------------------------------

describe("convertBotYaml — assistant-prompt-file validation", () => {
  test("warns when personaFile path does not exist on disk", () => {
    const legacy = loadFixture("missing-persona.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const personaWarn = result.warnings.find((w) => w.field === "agents[ghost].persona");
    expect(personaWarn).toBeDefined();
    expect(personaWarn!.message).toMatch(/assistant prompt file not found/);
  });

  test("skips file-existence check when configDir is omitted", () => {
    const legacy = loadFixture("missing-persona.bot.yaml");
    const result = convertBotYaml(legacy, {});
    // file-existence warning suppressed without a configDir
    const personaWarn = result.warnings.find(
      (w) => w.field === "agents[ghost].persona" && w.message.includes("not found"),
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
    expect(() => CortexConfigSchema.parse(asSchemaShape(result.cortex))).not.toThrow();
  });

  test("operator block carries discord + mattermost + dataResidency", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.principal).toEqual({
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
    if (dash?.kind === "dashboard") {
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
    // Fixture carries the legacy `local.{org}.>` token verbatim — this
    // test asserts the migrate-config converter passes nats config
    // through UNCHANGED. The legacy bot.yaml fixture is intentionally
    // NOT touched by the vocabulary migration (it's the source format
    // migrate-config reads from).
    expect(result.cortex.nats?.subjects).toEqual(["local.{org}.>"]);
  });

  test("bot.yaml-shape discord[].roles[] lifts into policy block (PR #310 r1 B-1 fix)", () => {
    // Echo PR #310 r1 BLOCKER caught: collectAdapterViews only walked
    // legacy.agents[].presence.<platform>.roles[] but bot.yaml-shape carries
    // roles at top-level legacy.discord[i].roles[] / legacy.mattermost[i].
    // The fix extends collectAdapterViews with a bot.yaml-shape branch that
    // zips top-level instances against the synthesised agents[] by index.
    //
    // Pre-fix: this fixture's discord[0].roles[].operator silently dropped,
    // leaving an empty policy block — every grove-v2 upgrade lost auth.
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    expect(result.cortex.policy).toBeDefined();
    const policy = result.cortex.policy!;
    // The legacy `operator` role + its users[] entry must surface as
    // (a) a PolicyRole with the operator capability, and
    // (b) a PolicyPrincipal whose platform_ids.discord includes 112233445566778899.
    const operatorRole = policy.roles.find((r) => r.id === "operator");
    expect(operatorRole).toBeDefined();
    expect(operatorRole?.capabilities).toContain("operator");
    const operatorPrincipal = policy.principals.find(
      (p) => p.platform_ids?.discord?.includes("112233445566778899"),
    );
    expect(operatorPrincipal).toBeDefined();
    expect(operatorPrincipal?.role).toContain("operator");
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- runtime malformed input
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
    expect(result.cortex.principal.dataResidency).toBe("CH");
    expect(result.warnings.some((w) => w.field === "principal.dataResidency")).toBe(true);
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
    expect(result.cortex.principal.dataResidency).toBe("NZ");
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
    expect(result.cortex.principal.id).toBe("jc");
    expect(result.warnings.some((w) => w.field === "principal.id")).toBe(true);
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
    expect(result.cortex.principal.id).toBe("luna");
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
    expect(() => CortexConfigSchema.parse(asSchemaShape(result.cortex))).not.toThrow();
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
    expect(d.enabled).toBe(true);
    // v2.0.0 (cortex#297) — `defaultRole` / `dm` retired from presence.
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
    // v2.0.0 (cortex#297) — `defaultRole` retired from presence.
    expect(m.allowedUsers).toEqual([]);
    expect(m.channels).toEqual([]);
  });

  test("malformed renderers entry throws at the conversion site (not the final parse)", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      renderers: [{ kind: "dashbord" }],
    };
    expect(() => convertBotYaml(legacy, {})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// cortex#88 item 1 — paths.* grove → cortex rewrite
// ---------------------------------------------------------------------------

describe("convertBotYaml — paths rewrite (cortex#88 item 1)", () => {
  test("rewrites grove path defaults under paths.* to cortex equivalents", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      paths: {
        publishedEventsDir: "~/.claude/events/published",
        logDir: "~/.config/grove/logs",
      },
    };
    const result = convertBotYaml(legacy, {});
    const paths = (result.cortex.paths ?? {}) as Record<string, string>;
    expect(paths.logDir).toBe("~/.config/cortex/logs");
    // Non-grove paths pass through unchanged
    expect(paths.publishedEventsDir).toBe("~/.claude/events/published");
    // Operator sees a warning surfacing the substitution
    const pathsWarn = result.warnings.find((w) => w.field === "paths");
    expect(pathsWarn?.message).toMatch(/grove path\(s\)/);
  });

  test("leaves a paths block that already targets cortex unchanged", () => {
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{ token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" }],
      paths: { logDir: "~/.config/cortex/logs" },
    };
    const result = convertBotYaml(legacy, {});
    const paths = (result.cortex.paths ?? {}) as Record<string, string>;
    expect(paths.logDir).toBe("~/.config/cortex/logs");
    expect(result.warnings.find((w) => w.field === "paths")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cortex#88 item 3 — agent id detection from role-resolver hints
// ---------------------------------------------------------------------------

describe("convertBotYaml — agent id detection (cortex#88 item 3)", () => {
  test("infers agent id from `agent-<X>` role hint when users[] is non-empty", () => {
    // Grove monobot bot.yaml shape: the discord adapter carries an
    // `agent-echo` role-resolver block with the bot's own Discord user id
    // in `users[]`. That's the canonical hint of WHICH agent this adapter
    // represents — migrate-config should emit `echo`, not `luna`.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{
        token: "echo-token",
        guildId: "1",
        agentChannelId: "2",
        logChannelId: "3",
        roles: [
          { name: "operator", users: ["112233445566778899"], features: ["chat"] },
          { name: "agent-echo", users: ["999888777666555444"], features: ["chat"] },
        ],
      }],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents).toHaveLength(1);
    expect(result.cortex.agents[0]!.id).toBe("echo");
    // Warning surfaces the inference for operator audit trail.
    const hintWarn = result.warnings.find((w) => w.field === "agents[0].id");
    expect(hintWarn?.message).toMatch(/inferred from role-resolver hint/);
  });

  test("falls back to agent.name when no role hint matches", () => {
    // No `agent-*` role at all — preserve pre-#88 behaviour
    // (deriveAgentId(agent.name) at index 0, numeric suffix at index ≥1).
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{
        token: "t",
        guildId: "1",
        agentChannelId: "2",
        logChannelId: "3",
        roles: [
          { name: "operator", users: ["112233445566778899"], features: ["chat"] },
        ],
      }],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents[0]!.id).toBe("luna");
    expect(result.warnings.find((w) => w.field === "agents[0].id")).toBeUndefined();
  });

  test("falls back to numeric suffix for second variant when no role hint matches", () => {
    // Two discord adapters, neither has an `agent-*` role hint. Index 0
    // gets `luna` (from agent.name), index 1 gets `luna-2`.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        { token: "t1", guildId: "1", agentChannelId: "2", logChannelId: "3" },
        { token: "t2", guildId: "10", agentChannelId: "20", logChannelId: "30" },
      ],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["luna", "luna-2"]);
  });

  test("first matching hint wins when multiple `agent-*` roles are present", () => {
    // Pathological config: two valid `agent-*` hints in one adapter's
    // roles[]. Deterministic policy is first-wins so an operator can rely
    // on top-of-list precedence when hand-editing.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{
        token: "t",
        guildId: "1",
        agentChannelId: "2",
        logChannelId: "3",
        roles: [
          { name: "agent-forge", users: ["111111111111111111"], features: ["chat"] },
          { name: "agent-echo", users: ["222222222222222222"], features: ["chat"] },
        ],
      }],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents[0]!.id).toBe("forge");
  });

  test("ignores `agent-*` roles whose users[] is empty", () => {
    // Brief specifies the hint requires users[] non-empty. An empty
    // users[] entry is structurally just a role definition — not a bot
    // identity claim. Fall through to agent.name.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{
        token: "t",
        guildId: "1",
        agentChannelId: "2",
        logChannelId: "3",
        roles: [
          { name: "agent-echo", users: [], features: ["chat"] },
        ],
      }],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents[0]!.id).toBe("luna");
  });

  test("applies role-resolver hints per adapter in a multi-discord bot.yaml", () => {
    // Three-adapter monobot (grove production shape). Each adapter carries
    // a distinct `agent-*` role-resolver hint — migrate-config should
    // emit three agents with the inferred ids in the SAME order as the
    // discord[] blocks (so per-instance mappings stay stable).
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        {
          token: "luna-token",
          guildId: "1",
          agentChannelId: "2",
          logChannelId: "3",
          roles: [{ name: "agent-luna", users: ["100000000000000001"], features: ["chat"] }],
        },
        {
          token: "echo-token",
          guildId: "10",
          agentChannelId: "20",
          logChannelId: "30",
          roles: [{ name: "agent-echo", users: ["200000000000000002"], features: ["chat"] }],
        },
        {
          token: "forge-token",
          guildId: "100",
          agentChannelId: "200",
          logChannelId: "300",
          roles: [{ name: "agent-forge", users: ["300000000000000003"], features: ["chat"] }],
        },
      ],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["luna", "echo", "forge"]);
  });
});

// ---------------------------------------------------------------------------
// cortex#106 items 1 + 2 — collision-fallback off-by-one + duplicate-hint warn
// ---------------------------------------------------------------------------

describe("convertBotYaml — collision fallback termination (cortex#119)", () => {
  test("numeric-fallback collision with earlier hint claim terminates (no infinite loop)", () => {
    // Pre-cortex#119: the while-loop body re-computed
    // `${baseId}-${variantIds.length + 1}` on every iteration without
    // advancing the counter. If that candidate was itself already
    // claimed — e.g. adapter[0]'s `agent-luna-2` hint claims `luna-2`,
    // then adapter[1] falls to numeric and also computes `luna-2` —
    // the loop spun forever.
    //
    // Post-fix: a local `n` counter advances inside the loop, so the
    // candidate space is strictly monotonic and termination is
    // guaranteed regardless of which ids `claimedIds` already holds.
    //
    // Concretely: adapter[0] hints `agent-luna-2` (id=`luna-2`),
    // adapter[1] has NO hint so falls to numeric (`luna-${1+1}` =
    // `luna-2`) which collides, the loop must walk to `luna-3`.
    const legacy: LegacyBotYaml = {
      agent: {
        name: "luna",
        displayName: "Luna",
        personaFile: "./personas/luna.md",
      },
      discord: [
        {
          token: "t1",
          guildId: "1",
          agentChannelId: "2",
          logChannelId: "3",
          // adapter[0] uses a role-resolver hint claiming `luna-2`
          // explicitly (operator-labelled, atypical but legal).
          roles: [
            {
              name: "agent-luna-2",
              users: ["100000000000000001"],
              features: ["chat"],
            },
          ],
        },
        {
          token: "t2",
          guildId: "10",
          agentChannelId: "20",
          logChannelId: "30",
          // adapter[1] has no `agent-*` hint — falls to numeric.
          // Numeric formula yields `luna-2` which is already claimed
          // by adapter[0]. Without the cortex#119 fix this hangs.
        },
      ],
    };

    // Termination check — pre-fix this assertion never gets reached
    // because convertBotYaml would not return. With the fix it
    // resolves the collision to `luna-3`.
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents.map((a) => a.id)).toEqual([
      "luna-2",
      "luna-3",
    ]);
  });
});

describe("convertBotYaml — collision fallback numbering (cortex#106 item 1)", () => {
  test("three adapters all hinting the same id walk luna, luna-2, luna-3", () => {
    // Pathological config: three adapters all carry `agent-luna` hints. The
    // first wins via the hint path; subsequent collisions must walk the
    // numeric ladder cleanly (`luna-2`, `luna-3`). Pre-cortex#106 the
    // fallback formula carried `+1+1`, jumping to `luna-3`, `luna-4`.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        {
          token: "t1", guildId: "1", agentChannelId: "2", logChannelId: "3",
          roles: [{ name: "agent-luna", users: ["100000000000000001"], features: ["chat"] }],
        },
        {
          token: "t2", guildId: "10", agentChannelId: "20", logChannelId: "30",
          roles: [{ name: "agent-luna", users: ["200000000000000002"], features: ["chat"] }],
        },
        {
          token: "t3", guildId: "100", agentChannelId: "200", logChannelId: "300",
          roles: [{ name: "agent-luna", users: ["300000000000000003"], features: ["chat"] }],
        },
      ],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["luna", "luna-2", "luna-3"]);
  });
});

describe("convertBotYaml — duplicate hint across adapters (cortex#106 item 2)", () => {
  test("warn fires when two adapters both claim the same `agent-<X>` hint", () => {
    // Operator misconfigured: two adapters both declare an `agent-echo`
    // role-resolver hint. The first wins (id="echo"); the second falls
    // back to numeric (`luna-2`). A WARN surfaces the collision so the
    // operator sees it instead of silently inheriting the wrong identity.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        {
          token: "t1", guildId: "1", agentChannelId: "2", logChannelId: "3",
          roles: [{ name: "agent-echo", users: ["100000000000000001"], features: ["chat"] }],
        },
        {
          token: "t2", guildId: "10", agentChannelId: "20", logChannelId: "30",
          roles: [{ name: "agent-echo", users: ["200000000000000002"], features: ["chat"] }],
        },
      ],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["echo", "luna-2"]);
    const dupWarn = result.warnings.find((w) =>
      w.message.includes("both claim agent-echo hint"),
    );
    expect(dupWarn).toBeDefined();
    expect(dupWarn!.message).toMatch(/agents \[echo,luna-2\] both claim agent-echo hint/);
    expect(dupWarn!.message).toMatch(/first wins; second falls back to numeric/);
    expect(dupWarn!.field).toBe("agents[1].id");
  });

  test("warn does NOT fire when each adapter declares a distinct `agent-<X>` hint", () => {
    // Healthy config: three adapters, three distinct hints. No duplicate-
    // hint warning should appear.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        {
          token: "t1", guildId: "1", agentChannelId: "2", logChannelId: "3",
          roles: [{ name: "agent-luna", users: ["100000000000000001"], features: ["chat"] }],
        },
        {
          token: "t2", guildId: "10", agentChannelId: "20", logChannelId: "30",
          roles: [{ name: "agent-echo", users: ["200000000000000002"], features: ["chat"] }],
        },
        {
          token: "t3", guildId: "100", agentChannelId: "200", logChannelId: "300",
          roles: [{ name: "agent-forge", users: ["300000000000000003"], features: ["chat"] }],
        },
      ],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.cortex.agents.map((a) => a.id)).toEqual(["luna", "echo", "forge"]);
    const dupWarns = result.warnings.filter((w) => w.message.includes("both claim agent-"));
    expect(dupWarns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cortex#88 item 4 — shared agentChannelId across agents
// ---------------------------------------------------------------------------

describe("convertBotYaml — shared agentChannelId warning (cortex#88 item 4)", () => {
  test("warn fires when 2+ agents share the same agentChannelId", () => {
    // Grove monobot production shape: three Discord adapters, each with
    // an `agent-*` role hint (so cortex#88 item 3's detection picks the
    // distinct ids), but all three repeat the same `agentChannelId`
    // because grove's bot.yaml carried one shared #agent-log channel.
    // After migrate-config, all three cortex agents emit with the same
    // id — per-agent log routing silently no-ops.
    const sharedChannel = "1487029848164536361";
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        {
          token: "luna-token",
          guildId: "1",
          agentChannelId: sharedChannel,
          logChannelId: "3",
          roles: [{ name: "agent-luna", users: ["100000000000000001"], features: ["chat"] }],
        },
        {
          token: "echo-token",
          guildId: "10",
          agentChannelId: sharedChannel,
          logChannelId: "30",
          roles: [{ name: "agent-echo", users: ["200000000000000002"], features: ["chat"] }],
        },
        {
          token: "forge-token",
          guildId: "100",
          agentChannelId: sharedChannel,
          logChannelId: "300",
          roles: [{ name: "agent-forge", users: ["300000000000000003"], features: ["chat"] }],
        },
      ],
    };
    const result = convertBotYaml(legacy, {});
    const sharedWarns = result.warnings.filter((w) => w.field === "agents.agentChannelId");
    expect(sharedWarns).toHaveLength(1);
    expect(sharedWarns[0]!.message).toMatch(/agents \[luna,echo,forge\] share agentChannelId 1487029848164536361/);
    expect(sharedWarns[0]!.message).toMatch(/set distinct channels in cortex.yaml for per-agent log routing/);
    // The channel id is NOT blanked — operator may want shared logging.
    for (const a of result.cortex.agents) {
      expect(a.presence.discord?.agentChannelId).toBe(sharedChannel);
    }
  });

  test("warn skipped when each agent has a distinct agentChannelId", () => {
    // Same multi-adapter monobot shape, but each adapter declares its own
    // channel id. No warning should fire.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [
        {
          token: "luna-token",
          guildId: "1",
          agentChannelId: "111111111111111111",
          logChannelId: "3",
          roles: [{ name: "agent-luna", users: ["100000000000000001"], features: ["chat"] }],
        },
        {
          token: "echo-token",
          guildId: "10",
          agentChannelId: "222222222222222222",
          logChannelId: "30",
          roles: [{ name: "agent-echo", users: ["200000000000000002"], features: ["chat"] }],
        },
        {
          token: "forge-token",
          guildId: "100",
          agentChannelId: "333333333333333333",
          logChannelId: "300",
          roles: [{ name: "agent-forge", users: ["300000000000000003"], features: ["chat"] }],
        },
      ],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.warnings.filter((w) => w.field === "agents.agentChannelId")).toHaveLength(0);
  });

  test("warn skipped for single-agent legacy bot.yaml", () => {
    // Single-adapter case can't share by definition — the detection must
    // not produce a spurious warning.
    const legacy: LegacyBotYaml = {
      agent: { name: "luna", displayName: "Luna", personaFile: "./personas/luna.md" },
      discord: [{
        token: "t",
        guildId: "1",
        agentChannelId: "111111111111111111",
        logChannelId: "3",
      }],
    };
    const result = convertBotYaml(legacy, {});
    expect(result.warnings.filter((w) => w.field === "agents.agentChannelId")).toHaveLength(0);
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
  test("lists principal, agents, renderers, mappings and warnings", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const report = formatCheckReport(result);
    // R3 (cortex#388) — the report header is keyed `principal:` now.
    expect(report).toMatch(/principal: jc/);
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
    expect(() => CortexConfigSchema.parse(asSchemaShape(written as Record<string, unknown>))).not.toThrow();
  });

  test("cortex#88 item 5: creates missing parent dir before writing --out", async () => {
    // Reproduce the fresh-host case: target lives under a non-existent
    // `~/.config/cortex/` equivalent. Without mkdirSync, writeFileSync
    // ENOENTs; with it, the dir is created and the write succeeds.
    const tmpRoot = mkdtempSync(join(tmpdir(), "cortex-mig-7-2e-mkdir-"));
    const out = join(tmpRoot, "fresh-host", "nested", "cortex.yaml");
    const code = await runMigrateConfig([
      join(FIXTURE_DIR, "minimal.bot.yaml"),
      "--out",
      out,
    ]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  test("--strict returns exit code 2 when warnings present", async () => {
    // missing-persona fixture produces an assistant-prompt-file-not-found warning
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

describe("convertBotYaml — disabled-adapter does not leak policy (PR #306 r1 M4 fix)", () => {
  test("agent with enabled:false discord presence does not synthesise allow-all anonymous principal", () => {
    // Echo PR #306 r1 M4 caught: the headless placeholder presence in
    // cortex.work.yaml (`enabled: false, token: placeholder-disabled,
    // guildId: "0"`) flowed through to buildPolicy and synthesised an
    // `anonymous-discord-<agent>` principal with `allow-all` capabilities
    // (schema-default defaultRole). Disabled = no auth surface = no
    // policy effect should leak.
    const legacy: LegacyBotYaml = {
      operator: {
        id: "andreas",
        displayName: "Andreas",
        dataResidency: "NZ",
      },
      stack: { id: "andreas/work", displayName: "Andreas — Work" },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          roles: [],
          trust: [],
          presence: {
            discord: {
              enabled: false,
              token: "placeholder-disabled",
              guildId: "0",
              agentChannelId: "0",
              logChannelId: "0",
            },
          },
        },
      ],
    } satisfies LegacyBotYaml;
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    // The disabled adapter should not produce ANY synthetic anonymous-*
    // principal nor any allow-all role.
    const anonPrincipals = result.cortex.policy?.principals.filter((p) =>
      p.id.startsWith("anonymous-"),
    ) ?? [];
    expect(anonPrincipals).toHaveLength(0);
    const allowAllRole = result.cortex.policy?.roles.find((r) => r.id === "allow-all");
    expect(allowAllRole).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cortex#324 (v2.0.3) — stack signing default-on
// ---------------------------------------------------------------------------

describe("convertBotYaml — stack signing (cortex#324)", () => {
  test("no stack.nkey_seed_path on input → emits warning suggesting the field be set", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const w = result.warnings.find((w) => w.field === "stack.nkey_seed_path");
    expect(w).toBeDefined();
    expect(w!.message).toContain("UNSIGNED");
    expect(w!.message).toContain("docs/sop-stack-identity.md");
  });

  test("autoStackKey + legacy nats.identity present → reuses seedPath + publicKey", () => {
    // full.bot.yaml's nats.identity is in the legacy {did, keyPath} shape,
    // which gets stripped by convertNats. Use a cortex-shape input where
    // nats.identity already carries seedPath + publicKey.
    const legacy: LegacyBotYaml = {
      agent: {
        name: "test-agent",
        displayName: "Test",
        operatorId: "test-op",
      },
      discord: [
        {
          token: "discord-token-xxxx",
          guildId: "100000000000000001",
          agentChannelId: "100000000000000002",
          logChannelId: "100000000000000003",
        },
      ],
      stack: { id: "test-op/research" },
      nats: {
        url: "nats://localhost:4222",
        identity: {
          seedPath: "~/.config/nats/cortex.nk",
          publicKey: "UD7OGEVBNJAUQ57H5NHSPJZOKKOXOZ4DEUJVAO5URHBIUAVSVTJGL4QV",
        },
      },
    };
    const result = convertBotYaml(legacy, {
      configDir: FIXTURE_DIR,
      autoStackKey: true,
    });
    expect(result.cortex.stack).toBeDefined();
    expect(result.cortex.stack?.nkey_seed_path).toBe("~/.config/nats/cortex.nk");
    expect(result.cortex.stack?.nkey_pub).toBe(
      "UD7OGEVBNJAUQ57H5NHSPJZOKKOXOZ4DEUJVAO5URHBIUAVSVTJGL4QV",
    );
    const w = result.warnings.find((w) => w.field === "stack.nkey_seed_path");
    expect(w).toBeDefined();
    expect(w!.message).toContain("auto-populated");
  });

  test("autoStackKey but no legacy nats.identity → falls through to warning, no field added", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, {
      configDir: FIXTURE_DIR,
      autoStackKey: true,
    });
    // No seedPath to reuse — stack stays untouched (or absent), warning fires.
    expect(result.cortex.stack?.nkey_seed_path).toBeUndefined();
    const w = result.warnings.find((w) => w.field === "stack.nkey_seed_path");
    expect(w).toBeDefined();
    expect(w!.message).toContain("UNSIGNED");
  });

  test("idempotent — input already has stack.nkey_seed_path → no warning, no overwrite", () => {
    const legacy: LegacyBotYaml = {
      agent: {
        name: "test-agent",
        displayName: "Test",
        operatorId: "test-op",
      },
      discord: [
        {
          token: "discord-token-xxxx",
          guildId: "100000000000000001",
          agentChannelId: "100000000000000002",
          logChannelId: "100000000000000003",
        },
      ],
      stack: {
        id: "test-op/research",
        nkey_seed_path: "~/.config/nats/pre-existing.nk",
        nkey_pub: "UD7OGEVBNJAUQ57H5NHSPJZOKKOXOZ4DEUJVAO5URHBIUAVSVTJGL4QV",
      } as unknown as LegacyBotYaml["stack"],
      nats: {
        url: "nats://localhost:4222",
        identity: {
          seedPath: "~/.config/nats/different.nk",
          publicKey: "UDEQUP3NUQAGUJIZ5ZSOBZKAF73CW6BPMEQX6476E66Q37FONADJ75EB",
        },
      },
    };
    const result = convertBotYaml(legacy, {
      configDir: FIXTURE_DIR,
      autoStackKey: true,
    });
    // Pre-existing field preserved verbatim — NOT overwritten by autoStackKey.
    expect(result.cortex.stack?.nkey_seed_path).toBe(
      "~/.config/nats/pre-existing.nk",
    );
    // No new warning — the field was already set, idempotent no-op.
    const w = result.warnings.find((w) => w.field === "stack.nkey_seed_path");
    expect(w).toBeUndefined();
  });
});

describe("parseArgs — --auto-stack-key (cortex#324)", () => {
  test("parses --auto-stack-key flag", () => {
    const args = parseArgs(["in.yaml", "--auto-stack-key"]);
    expect(args.autoStackKey).toBe(true);
  });

  test("default is false", () => {
    const args = parseArgs(["in.yaml"]);
    expect(args.autoStackKey).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3 vocabulary migration (cortex#388) — migrate-config emits `principal:`
// ---------------------------------------------------------------------------

describe("convertBotYaml — R3 principal block emission (cortex#388)", () => {
  test("emits a `principal:` block, not a legacy `operator:` block", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    // The emitted object carries the new canonical key.
    expect(result.cortex.principal).toBeDefined();
    expect(result.cortex.principal.id).toBe("jc");
    // The legacy `operator:` key is gone from the emitted shape.
    expect((result.cortex as Record<string, unknown>).operator).toBeUndefined();
  });

  test("the emitted `principal:`-shaped YAML loads through CortexConfigSchema after normalisation", () => {
    const legacy = loadFixture("full.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    // YAML round-trip: stringify → parse → normalise principal→operator →
    // schema-validate (mirrors what the cortex loader does at startup).
    const yamlText = YAML.stringify(result.cortex);
    const reparsed = YAML.parse(yamlText) as Record<string, unknown>;
    expect(reparsed.principal).toBeDefined();
    expect(reparsed.operator).toBeUndefined();
    expect(() =>
      CortexConfigSchema.parse(asSchemaShape(reparsed)),
    ).not.toThrow();
  });

  test("round-trips a legacy `operator:`-shaped cortex.yaml into a `principal:`-shaped one", () => {
    // Completion-signal #4: migrate-config takes a v2 `operator:`-shaped
    // cortex.yaml as input and emits a v3 `principal:`-shaped one without
    // losing fields.
    const operatorShapedInput: LegacyBotYaml = {
      operator: {
        id: "andreas",
        displayName: "Andreas",
        discordId: "112233445566778899",
        dataResidency: "NZ",
      },
      stack: { id: "andreas/work" },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          trust: [],
          presence: {
            discord: {
              token: "discord-token-xxxx",
              guildId: "100000000000000001",
              agentChannelId: "100000000000000002",
              logChannelId: "100000000000000003",
            },
          },
        },
      ],
    };
    const result = convertBotYaml(operatorShapedInput, { configDir: FIXTURE_DIR });
    expect(result.cortex.principal.id).toBe("andreas");
    expect(result.cortex.principal.displayName).toBe("Andreas");
    expect(result.cortex.principal.discordId).toBe("112233445566778899");
    expect(result.cortex.principal.dataResidency).toBe("NZ");
    expect((result.cortex as Record<string, unknown>).operator).toBeUndefined();
    expect(result.cortex.agents).toHaveLength(1);
    expect(result.cortex.agents[0]!.id).toBe("luna");
  });

  test("round-trips an already-migrated `principal:`-shaped cortex.yaml (idempotent)", () => {
    const principalShapedInput: LegacyBotYaml = {
      principal: {
        id: "andreas",
        displayName: "Andreas",
        dataResidency: "NZ",
      },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          trust: [],
          presence: {
            discord: {
              token: "discord-token-xxxx",
              guildId: "100000000000000001",
              agentChannelId: "100000000000000002",
              logChannelId: "100000000000000003",
            },
          },
        },
      ],
    };
    const result = convertBotYaml(principalShapedInput, { configDir: FIXTURE_DIR });
    expect(result.cortex.principal.id).toBe("andreas");
    expect((result.cortex as Record<string, unknown>).operator).toBeUndefined();
  });

  test("rejects input carrying BOTH a `principal:` and a legacy `operator:` block", () => {
    // Trust-boundary regression — a config with two principal blocks is
    // ambiguous and must be rejected before any conversion work.
    const dualBlockInput = {
      principal: { id: "andreas" },
      operator: { id: "someone-else" },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    expect(() => convertBotYaml(dualBlockInput, { configDir: FIXTURE_DIR })).toThrow(
      /BOTH a `principal:` block and a legacy `operator:` block/,
    );
  });
});

// ---------------------------------------------------------------------------
// cortex#428 (PR-B) — v3-complete syntheses: Stage 4-A wiring
// ---------------------------------------------------------------------------
//
// Each synthesis is exercised against both a bot.yaml-shape input (grove-v2
// legacy) and a cortex.yaml-shape input (post-MIG-7.9 — Andreas's production
// shape). The post-PR test target is: a freshly-migrated cortex.yaml runs
// Stage 4-A end-to-end on v3.0.x without manual editing.

describe("convertBotYaml — cortex#428 PR-B runtime.capabilities synthesis", () => {
  test("default-synthesises capabilities = [chat] when no runtime block declared", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const agent = result.cortex.agents[0]!;
    expect(agent.runtime).toBeDefined();
    expect(agent.runtime!.substrate).toBe("claude-code");
    expect(agent.runtime!.mode).toBe("in-process");
    expect(agent.runtime!.capabilities).toEqual(["chat"]);
  });

  test("assistant-prompt heuristic adds code-review.typescript at exactly the 2-match floor", () => {
    // Boundary test: the regex `/code[- ]review|reviewer|reviewing/gi`
    // must match EXACTLY 2 times to land on the floor and trip the
    // heuristic. The fixture below contains "Code review" and
    // "code-review" (and nothing else that matches), so matches=2.
    // Reducing this fixture by one match should make the next test
    // case (which sits at matches=1) fail-closed instead.
    const tmp = mkdtempSync(join(tmpdir(), "cortex-mig-428-cap-floor-"));
    const persona = join(tmp, "echo.md");
    writeFileSync(persona, "# Echo\nCode review and code-review work.\n");
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "echo",
          displayName: "Echo",
          persona,
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: tmp });
    expect(result.cortex.agents[0]!.runtime!.capabilities).toEqual(
      expect.arrayContaining(["chat", "code-review.typescript"]),
    );
  });

  test("assistant-prompt heuristic stays at [chat] with exactly 1 keyword match (below floor)", () => {
    // The complement of the floor test above: matches=1 must NOT add
    // code-review.typescript. Together the two tests pin the floor at
    // the regex boundary instead of via the loose "Forge deflector"
    // fixture (which mixed deflection prose with a single hit and is
    // kept as a real-world repro lower down).
    const tmp = mkdtempSync(join(tmpdir(), "cortex-mig-428-cap-below-"));
    const persona = join(tmp, "solo.md");
    writeFileSync(persona, "# Solo\nThis agent does code-review only on Tuesdays.\n");
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "solo",
          displayName: "Solo",
          persona,
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: tmp });
    expect(result.cortex.agents[0]!.runtime!.capabilities).toEqual(["chat"]);
  });

  test("assistant prompt with only one review-keyword mention stays at [chat] (deflector test)", () => {
    // Production-bug repro: Forge's assistant prompt on Andreas's deployment
    // mentions "code review" once while DEFLECTING review work to Echo
    // ("Code review. That's Echo. If anyone asks you for a review,
    // redirect"). A single mention must NOT trip the heuristic.
    const tmp = mkdtempSync(join(tmpdir(), "cortex-mig-428-deflect-"));
    const persona = join(tmp, "forge.md");
    writeFileSync(persona, "# Forge\nCode review — that's Echo's job, not mine.\n");
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "forge",
          displayName: "Forge",
          persona,
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: tmp });
    expect(result.cortex.agents[0]!.runtime!.capabilities).toEqual(["chat"]);
  });

  test("assistant-prompt heuristic skips oversized files with a warning (defence-in-depth size cap)", () => {
    // Defence-in-depth regression for the cortex#432 nit-3 size cap. A
    // hostile or accidental large assistant prompt file (`persona: /dev/zero`,
    // stray huge fixture) must NOT OOM the migrator. The 1 MiB cap is well
    // above any realistic assistant prompt; we synthesise a file just over the
    // cap and assert (a) the heuristic short-circuits to [chat] and
    // (b) a ConversionWarning surfaces so the operator sees the skip.
    const tmp = mkdtempSync(join(tmpdir(), "cortex-mig-428-cap-oversize-"));
    const persona = join(tmp, "huge.md");
    // 1 MiB + 1 byte — sized via Buffer.alloc to avoid materialising a
    // multi-MB string literal in test source. Content is irrelevant
    // (the heuristic never runs); the size gate fires on statSync.
    const oversize = 1 * 1024 * 1024 + 1;
    writeFileSync(persona, Buffer.alloc(oversize, "x"));
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "huge",
          displayName: "Huge",
          persona,
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: tmp });
    expect(result.cortex.agents[0]!.runtime!.capabilities).toEqual(["chat"]);
    const sizeWarning = result.warnings.find(
      (w) =>
        w.field === "agents[huge].persona" &&
        w.message.includes("byte cap") &&
        w.message.includes("skipping assistant-prompt-driven capability heuristic"),
    );
    expect(sizeWarning).toBeDefined();
  });

  test("idempotent — existing runtime.capabilities preserved + chat appended if missing", () => {
    // Cortex-shape input that already declares capabilities should keep
    // them and gain `chat` (so dispatch can still route conversational
    // envelopes alongside the specialised work). The pre-existing fields
    // (sovereignty, maxConcurrent, …) on the runtime block must survive.
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "echo",
          displayName: "Echo",
          persona: "./personas/echo.md",
          trust: [],
          runtime: {
            substrate: "claude-code",
            mode: "in-process",
            capabilities: ["code-review.typescript", "code-review.security"],
            sovereignty: "strict",
            maxConcurrent: 3,
          },
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: FIXTURE_DIR });
    const rt = result.cortex.agents[0]!.runtime!;
    expect(rt.capabilities).toEqual(
      expect.arrayContaining(["chat", "code-review.typescript", "code-review.security"]),
    );
    expect(rt.sovereignty).toBe("strict");
    expect(rt.maxConcurrent).toBe(3);
  });

  test("idempotent — chat already declared does not get duplicated", () => {
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          trust: [],
          runtime: {
            substrate: "claude-code",
            mode: "in-process",
            capabilities: ["chat"],
          },
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.runtime!.capabilities).toEqual(["chat"]);
  });

  test("buildAgentsFromCortexShape passes through agent.runtime fields (regression for incidental fix in cortex#428)", () => {
    // Dedicated regression for the cortex#428 buildAgentsFromCortexShape
    // runtime-passthrough fix (migrate-config-lib.ts:1672). Earlier coverage
    // was only via the idempotency test, which also runs
    // synthesizeRuntimeCapabilities — that path would re-attach a runtime
    // block (with substrate/mode/capabilities defaults) even if the
    // passthrough were absent, hiding a regression. This test asserts the
    // fields that synthesis does NOT touch (sovereignty, maxConcurrent)
    // survive the round-trip end-to-end on a v3-shape input.
    const cortexShape = {
      principal: { id: "andreas" },
      agents: [
        {
          id: "echo",
          displayName: "Echo",
          persona: "./personas/echo.md",
          trust: [],
          runtime: {
            substrate: "claude-code",
            mode: "in-process",
            capabilities: ["chat"],
            sovereignty: "selective",
            maxConcurrent: 7,
          },
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: FIXTURE_DIR });
    const rt = result.cortex.agents[0]!.runtime!;
    expect(rt.capabilities).toEqual(["chat"]);
    // The two fields below are NOT touched by synthesizeRuntimeCapabilities;
    // if buildAgentsFromCortexShape stops passing the runtime block through,
    // these assertions fail immediately (whereas capabilities=[chat] would
    // still hold from synthesis defaults).
    expect(rt.sovereignty).toBe("selective");
    expect(rt.maxConcurrent).toBe(7);
  });

  test("catalog augmentation — synthesised cap ids appear in top-level capabilities[]", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const catalog = result.cortex.capabilities;
    const chatEntry = catalog.find((c) => c.id === "chat");
    expect(chatEntry).toBeDefined();
    expect(chatEntry!.provided_by).toContain("luna");
  });

  test("catalog merge — pre-existing entry survives, provided_by unioned", () => {
    // Existing catalog has code-review.typescript with one provider (echo).
    // Echo's runtime claims it; another agent's assistant-prompt heuristic also
    // would, BUT the heuristic only fires when no caps were declared. So
    // the test exercises the unconditional `chat` cap append + the
    // preserve-existing-catalog-entry path.
    const cortexShape = {
      principal: { id: "andreas" },
      capabilities: [
        {
          id: "code-review.typescript",
          description: "Hand-written description — preserve me.",
          provided_by: ["echo"],
        },
      ],
      agents: [
        {
          id: "echo",
          displayName: "Echo",
          persona: "./personas/echo.md",
          trust: [],
          runtime: {
            substrate: "claude-code",
            mode: "in-process",
            capabilities: ["code-review.typescript"],
          },
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: FIXTURE_DIR });
    const tsCap = result.cortex.capabilities.find((c) => c.id === "code-review.typescript");
    expect(tsCap).toBeDefined();
    expect(tsCap!.description).toBe("Hand-written description — preserve me.");
    expect(tsCap!.provided_by).toEqual(["echo"]); // already listed; no dup
    const chatCap = result.cortex.capabilities.find((c) => c.id === "chat");
    expect(chatCap).toBeDefined();
    expect(chatCap!.provided_by).toContain("echo");
  });

  test("output round-trips through CortexConfigSchema (cross-validator passes)", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    // Cross-validator (cortex#314) rejects any runtime.capability not in
    // the top-level catalog. If the synthesis missed that mirroring, this
    // re-parse fails. Belt-and-suspenders alongside the in-conversion
    // parse, since `convertBotYaml` itself parses on the way out.
    expect(() => CortexConfigSchema.parse(asSchemaShape(result.cortex))).not.toThrow();
  });

  test("emits a warning for every agent that gained a synthesised capability", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const synthesisWarnings = result.warnings.filter((w) =>
      w.field.startsWith("agents[") && w.field.endsWith("].runtime.capabilities"),
    );
    expect(synthesisWarnings.length).toBeGreaterThanOrEqual(1);
    expect(synthesisWarnings[0]!.message).toContain("chat");
  });
});

describe("convertBotYaml — cortex#428 PR-B presence.surfaceSubjects synthesis", () => {
  test("default-synthesises surfaceSubjects on discord adapter for bot.yaml input", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const discord = result.cortex.agents[0]!.presence.discord;
    expect(discord).toBeDefined();
    // bot.yaml has no `stack:` block, so derives to {principal.id}/default.
    // The minimal fixture's principal is `jc`, so the synthesised default
    // subject is `local.jc.default.dispatch.task.*`.
    expect(discord!.surfaceSubjects).toEqual(["local.jc.default.dispatch.task.*"]);
  });

  test("uses explicit stack.id when set (cortex.yaml-shape input)", () => {
    const cortexShape = {
      principal: { id: "andreas" },
      stack: { id: "andreas/meta-factory" },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.presence.discord!.surfaceSubjects).toEqual([
      "local.andreas.meta-factory.dispatch.task.*",
    ]);
  });

  test("idempotent — non-empty surfaceSubjects preserved verbatim", () => {
    // Echo's production shape: explicit code-review subject already set.
    // The migrator must NOT overwrite it.
    const cortexShape = {
      principal: { id: "andreas" },
      stack: { id: "andreas/meta-factory" },
      agents: [
        {
          id: "echo",
          displayName: "Echo",
          persona: "./personas/echo.md",
          trust: [],
          presence: {
            discord: {
              token: "t",
              guildId: "1",
              agentChannelId: "2",
              logChannelId: "3",
              surfaceSubjects: ["local.andreas.meta-factory.tasks.code-review.>"],
            },
          },
        },
      ],
    } as unknown as LegacyBotYaml;
    const result = convertBotYaml(cortexShape, { configDir: FIXTURE_DIR });
    expect(result.cortex.agents[0]!.presence.discord!.surfaceSubjects).toEqual([
      "local.andreas.meta-factory.tasks.code-review.>",
    ]);
  });

  test("emits a warning per adapter that gained a synthesised subjects list", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const surfaceWarnings = result.warnings.filter((w) =>
      w.field.includes("surfaceSubjects"),
    );
    expect(surfaceWarnings.length).toBeGreaterThanOrEqual(1);
    expect(surfaceWarnings[0]!.message).toMatch(/local\..*\.dispatch\.task\.\*/);
  });
});

describe("convertBotYaml — cortex#428 PR-B agent.operatorId back-compat", () => {
  test("attaches transient operatorId = principal.id on every agent", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    for (const agent of result.cortex.agents) {
      // Type-laundering required — operatorId is not in the schema. The
      // synthesis attaches it post-parse so the migrator's YAML output
      // boots on v3.0.0–v3.0.3 (pre-PR-A) where the field IS read.
      const raw = agent as unknown as Record<string, unknown>;
      expect(raw.operatorId).toBe(result.cortex.principal.id);
    }
  });

  test("survives YAML round-trip — operatorId appears in serialised output", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const yamlOut = YAML.stringify(result.cortex);
    expect(yamlOut).toContain("operatorId: jc");
  });

  test("emits a warning explaining the deprecation timeline", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const opIdWarn = result.warnings.find((w) => w.field === "agents[].operatorId");
    expect(opIdWarn).toBeDefined();
    expect(opIdWarn!.message).toMatch(/v3\.0\.0–v3\.0\.3.*back-compat/);
    expect(opIdWarn!.message).toMatch(/cortex#429/);
  });
});

describe("formatCheckReport — cortex#428 PR-B reflects synthesised fields", () => {
  test("renders runtime + capabilities + surfaceSubjects on each agent", () => {
    const legacy = loadFixture("minimal.bot.yaml");
    const result = convertBotYaml(legacy, { configDir: FIXTURE_DIR });
    const report = formatCheckReport(result);
    expect(report).toContain("runtime: substrate=claude-code mode=in-process capabilities=[chat]");
    expect(report).toContain("discord.surfaceSubjects: [local.jc.default.dispatch.task.*]");
    expect(report).toContain("capabilities: ");
    expect(report).toContain("chat provided_by=[luna]");
  });
});
