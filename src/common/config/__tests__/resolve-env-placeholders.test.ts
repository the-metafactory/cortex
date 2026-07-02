/**
 * cortex#1209 / cortex#1217 — `__ENV__` placeholder resolution for surface
 * secret fields, with fail-SOFT per-surface degradation.
 *
 * Acceptance cases:
 *   - `token: __VEGA_BOT_TOKEN__` + env set → adapter receives the real token.
 *   - placeholder + UNSET env → that ONE surface is DISABLED (`enabled:false`)
 *     + scrubbed (no literal `__X__` survives) + a WARN is collected; the load
 *     does NOT throw and the agent + rest of the config still load (cortex#1217
 *     — the fail-closed throw used to crash-loop the whole stack).
 *   - inline token → unchanged.
 *   - Pier's `__PIER_BOT_TOKEN__` resolves the same way (fragment path).
 *   - the surfaces.yaml gateway-binding path fails soft by DROPPING the entry.
 *
 * The unit layer here exercises the resolver directly + through the loader
 * (`loadConfigWithAgents` for inline `agents[]`, `loadAgentFromFile` for an
 * agents.d/ fragment). The loader is a boot path, so we drive it end-to-end
 * with real temp files rather than mocking.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";

import {
  ENV_PLACEHOLDER_PATTERN,
  EnvPlaceholderError,
  assertNoUnresolvedPlaceholder,
  resolveAgentPresenceTokens,
  resolveSurfaceBindingTokens,
  resolveSurfaceTokensInRawConfig,
  type SurfaceTokenWarning,
} from "../resolve-env-placeholders";
import type { Surfaces } from "../../types/surfaces";
import {
  loadConfigWithAgents,
  loadAgentFromFile,
  loadAgentsDirectory,
  flattenDiscordPresences,
  surfaceInstanceEnabled,
} from "../loader";
import type { Agent } from "../../types/cortex-config";

// ---------------------------------------------------------------------------
// env hygiene — snapshot + restore the env vars these tests poke so they never
// leak across tests (the resolver reads process.env directly).
// ---------------------------------------------------------------------------
const TOUCHED = [
  "VEGA_BOT_TOKEN",
  "PIER_BOT_TOKEN",
  "MM_API_TOKEN",
  "SLACK_BOT",
  "SLACK_APP",
  "GW_DISCORD_TOKEN",
  "WS_ONLY_TOKEN",
  // compass#84 (L2) — surface ID placeholder env vars.
  "PIER_GUILD_ID",
  "PIER_AGENT_CHANNEL_ID",
  "PIER_LOG_CHANNEL_ID",
  "GW_GUILD_ID",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = saved[k];
  }
});

// ===========================================================================
// Pattern + scalar resolver
// ===========================================================================
describe("ENV_PLACEHOLDER_PATTERN", () => {
  test("matches a pure SCREAMING_CASE placeholder", () => {
    expect(ENV_PLACEHOLDER_PATTERN.exec("__VEGA_BOT_TOKEN__")?.[1]).toBe("VEGA_BOT_TOKEN");
  });

  test("does NOT match partial / lowercase / embedded forms", () => {
    expect(ENV_PLACEHOLDER_PATTERN.test("Bearer __X__")).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test("__lower__")).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test("xoxb-real-token")).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test("__A B__")).toBe(false);
  });

  test("the scrub sentinels are NOT themselves placeholders (assert never re-fires)", () => {
    // The disabled-surface sentinels must not look like `__ENV__` placeholders,
    // or a downstream resolve pass / the belt-and-suspenders assert would trip.
    expect(ENV_PLACEHOLDER_PATTERN.test("DISABLED-MISSING-SECRET-VEGA_BOT_TOKEN")).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test("xoxb-DISABLED-SLACK_BOT")).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test("xapp-DISABLED-SLACK_APP")).toBe(false);
  });
});

describe("resolveAgentPresenceTokens — resolve / inline (unchanged behaviour)", () => {
  test("resolves a discord token placeholder from env", () => {
    process.env.VEGA_BOT_TOKEN = "real-vega-token";
    const agent: Record<string, unknown> = {
      id: "vega",
      presence: { discord: { enabled: true, token: "__VEGA_BOT_TOKEN__" } },
    };
    resolveAgentPresenceTokens(agent, "agents[0]");
    expect((agent.presence as any).discord.token).toBe("real-vega-token");
    // resolved surface stays enabled
    expect((agent.presence as any).discord.enabled).toBe(true);
  });

  test("inline token passes through byte-identical", () => {
    const agent: Record<string, unknown> = {
      id: "vega",
      presence: { discord: { enabled: true, token: "inline-real-token-123" } },
    };
    resolveAgentPresenceTokens(agent, "agents[0]");
    expect((agent.presence as any).discord.token).toBe("inline-real-token-123");
    expect((agent.presence as any).discord.enabled).toBe(true);
  });

  test("resolves mattermost.apiToken + slack.botToken/appToken", () => {
    process.env.MM_API_TOKEN = "mm-real";
    process.env.SLACK_BOT = "xoxb-real";
    process.env.SLACK_APP = "xapp-real";
    const agent: Record<string, unknown> = {
      id: "echo",
      presence: {
        mattermost: { apiToken: "__MM_API_TOKEN__" },
        slack: { botToken: "__SLACK_BOT__", appToken: "__SLACK_APP__" },
      },
    };
    resolveAgentPresenceTokens(agent, "agents[0]");
    expect((agent.presence as any).mattermost.apiToken).toBe("mm-real");
    expect((agent.presence as any).slack.botToken).toBe("xoxb-real");
    expect((agent.presence as any).slack.appToken).toBe("xapp-real");
  });

  test("no presence block → no-op", () => {
    const agent: Record<string, unknown> = { id: "x" };
    expect(() => resolveAgentPresenceTokens(agent, "agents[0]")).not.toThrow();
  });
});

describe("resolveAgentPresenceTokens — fail SOFT on unset env (cortex#1217)", () => {
  test("unset env → surface DISABLED, literal scrubbed, NO throw, WARN collected", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const agent: Record<string, unknown> = {
      id: "vega",
      presence: { discord: { enabled: true, token: "__VEGA_BOT_TOKEN__" } },
    };
    const warnings: SurfaceTokenWarning[] = [];
    // does NOT throw
    expect(() => resolveAgentPresenceTokens(agent, "agents[0]", warnings)).not.toThrow();
    const discord = (agent.presence as any).discord;
    // surface disabled
    expect(discord.enabled).toBe(false);
    // the literal placeholder must NOT survive
    expect(discord.token).not.toBe("__VEGA_BOT_TOKEN__");
    expect(ENV_PLACEHOLDER_PATTERN.test(discord.token)).toBe(false);
    // warning names the agent + env var (never a thrown error)
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      agent: "vega",
      platform: "discord",
      envVar: "VEGA_BOT_TOKEN",
      fieldPath: "agents[0].presence.discord.token",
    });
  });

  test("EMPTY / whitespace-only env var is treated as unset → soft-disable", () => {
    process.env.VEGA_BOT_TOKEN = "   ";
    const agent: Record<string, unknown> = {
      id: "vega",
      presence: { discord: { enabled: true, token: "__VEGA_BOT_TOKEN__" } },
    };
    const warnings: SurfaceTokenWarning[] = [];
    resolveAgentPresenceTokens(agent, "agents[0]", warnings);
    expect((agent.presence as any).discord.enabled).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  test("slack botToken missing → disabled + scrubbed to a schema-valid xoxb- sentinel", () => {
    delete process.env.SLACK_BOT;
    process.env.SLACK_APP = "xapp-real";
    const agent: Record<string, unknown> = {
      id: "sage",
      presence: { slack: { enabled: true, botToken: "__SLACK_BOT__", appToken: "__SLACK_APP__" } },
    };
    const warnings: SurfaceTokenWarning[] = [];
    resolveAgentPresenceTokens(agent, "agents[0]", warnings);
    const slack = (agent.presence as any).slack;
    expect(slack.enabled).toBe(false);
    // scrubbed sentinel still satisfies the `^xoxb-` schema regex (so the parse
    // downstream does not choke), but is plainly not a real token + not a literal
    expect(slack.botToken.startsWith("xoxb-")).toBe(true);
    expect(ENV_PLACEHOLDER_PATTERN.test(slack.botToken)).toBe(false);
    expect(warnings[0]?.platform).toBe("slack");
  });

  test("one disabled surface does not affect a sibling resolvable surface", () => {
    delete process.env.VEGA_BOT_TOKEN;
    process.env.MM_API_TOKEN = "mm-real";
    const agent: Record<string, unknown> = {
      id: "vega",
      presence: {
        discord: { enabled: true, token: "__VEGA_BOT_TOKEN__" },
        mattermost: { enabled: true, apiToken: "__MM_API_TOKEN__" },
      },
    };
    const warnings: SurfaceTokenWarning[] = [];
    resolveAgentPresenceTokens(agent, "agents[0]", warnings);
    // discord disabled, mattermost still live + resolved
    expect((agent.presence as any).discord.enabled).toBe(false);
    expect((agent.presence as any).mattermost.enabled).toBe(true);
    expect((agent.presence as any).mattermost.apiToken).toBe("mm-real");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.platform).toBe("discord");
  });
});

// ===========================================================================
// compass#84 (L2) — surface ID placeholder fields (guildId / agentChannelId /
// logChannelId). Symmetric to the surface *token* fields: a live guild/channel
// snowflake in a SHIPPABLE fragment (Pier ships to the public arc package) is
// deployment config, not template content. Shipping it as `__PIER_GUILD_ID__`
// keeps the literal ID out of the repo and resolves it from the daemon env at
// load — failing SOFT (surface disabled + WARN, never a crash) when unset.
// ===========================================================================
describe("resolveAgentPresenceTokens — surface ID placeholders (compass#84 L2)", () => {
  test("resolves guildId/agentChannelId/logChannelId placeholders from env", () => {
    process.env.PIER_GUILD_ID = "000000000000000001";
    process.env.PIER_AGENT_CHANNEL_ID = "000000000000000002";
    process.env.PIER_LOG_CHANNEL_ID = "000000000000000003";
    const agent: Record<string, unknown> = {
      id: "pier",
      presence: {
        discord: {
          enabled: true,
          token: "inline-token",
          guildId: "__PIER_GUILD_ID__",
          agentChannelId: "__PIER_AGENT_CHANNEL_ID__",
          logChannelId: "__PIER_LOG_CHANNEL_ID__",
        },
      },
    };
    resolveAgentPresenceTokens(agent, "agents.d/pier.yaml");
    const discord = (agent.presence as any).discord;
    expect(discord.guildId).toBe("000000000000000001");
    expect(discord.agentChannelId).toBe("000000000000000002");
    expect(discord.logChannelId).toBe("000000000000000003");
    // all resolvable ⇒ surface stays enabled
    expect(discord.enabled).toBe(true);
  });

  test("inline (non-placeholder) IDs pass through byte-identical", () => {
    const agent: Record<string, unknown> = {
      id: "luna",
      presence: {
        discord: {
          enabled: true,
          token: "inline-token",
          guildId: "123456789012345678",
          agentChannelId: "223456789012345678",
          logChannelId: "323456789012345678",
        },
      },
    };
    resolveAgentPresenceTokens(agent, "agents[0]");
    const discord = (agent.presence as any).discord;
    expect(discord.guildId).toBe("123456789012345678");
    expect(discord.agentChannelId).toBe("223456789012345678");
    expect(discord.enabled).toBe(true);
  });

  test("unset ID env → surface DISABLED, literal scrubbed (not a placeholder), WARN collected", () => {
    delete process.env.PIER_GUILD_ID;
    const agent: Record<string, unknown> = {
      id: "pier",
      presence: {
        discord: { enabled: true, token: "inline-token", guildId: "__PIER_GUILD_ID__" },
      },
    };
    const warnings: SurfaceTokenWarning[] = [];
    expect(() => resolveAgentPresenceTokens(agent, "agents.d/pier.yaml", warnings)).not.toThrow();
    const discord = (agent.presence as any).discord;
    // surface disabled — a missing ID is as disqualifying as a missing token
    expect(discord.enabled).toBe(false);
    // the literal placeholder must NOT survive, and the scrub must NOT itself
    // look like a placeholder (or a downstream resolve pass / the assert trips)
    expect(discord.guildId).not.toBe("__PIER_GUILD_ID__");
    expect(ENV_PLACEHOLDER_PATTERN.test(discord.guildId)).toBe(false);
    // scrub is a non-empty string ⇒ still satisfies the `.min(1)` schema
    expect(discord.guildId.length).toBeGreaterThan(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      agent: "pier",
      platform: "discord",
      envVar: "PIER_GUILD_ID",
      fieldPath: "agents.d/pier.yaml.presence.discord.guildId",
    });
  });

  test("a resolvable token but an unset ID env still disables the surface", () => {
    process.env.PIER_BOT_TOKEN = "real-token";
    delete process.env.PIER_LOG_CHANNEL_ID;
    const agent: Record<string, unknown> = {
      id: "pier",
      presence: {
        discord: {
          enabled: true,
          token: "__PIER_BOT_TOKEN__",
          guildId: "123456789012345678",
          logChannelId: "__PIER_LOG_CHANNEL_ID__",
        },
      },
    };
    const warnings: SurfaceTokenWarning[] = [];
    resolveAgentPresenceTokens(agent, "agents.d/pier.yaml", warnings);
    const discord = (agent.presence as any).discord;
    // token resolved fine, but the missing channel ID disables the surface
    expect(discord.token).toBe("real-token");
    expect(discord.enabled).toBe(false);
    expect(warnings.map((w) => w.envVar)).toContain("PIER_LOG_CHANNEL_ID");
  });

  test("optional worklogChannelId placeholder resolves when set; absent → no-op", () => {
    process.env.PIER_LOG_CHANNEL_ID = "000000000000000009";
    const agent: Record<string, unknown> = {
      id: "pier",
      presence: {
        discord: { enabled: true, token: "inline", guildId: "1", worklogChannelId: "__PIER_LOG_CHANNEL_ID__" },
      },
    };
    expect(() => resolveAgentPresenceTokens(agent, "agents[0]")).not.toThrow();
    expect((agent.presence as any).discord.worklogChannelId).toBe("000000000000000009");
    // a fragment with no worklogChannelId key at all must not choke
    const bare: Record<string, unknown> = {
      id: "x",
      presence: { discord: { enabled: true, token: "inline", guildId: "1" } },
    };
    expect(() => resolveAgentPresenceTokens(bare, "agents[0]")).not.toThrow();
    expect((bare.presence as any).discord.enabled).toBe(true);
  });
});

describe("resolveSurfaceBindingTokens — ID placeholders (compass#84 L2)", () => {
  test("resolves a binding.guildId placeholder from env", () => {
    process.env.GW_GUILD_ID = "000000000000000010";
    const surfaces = {
      discord: [
        {
          agent: "pier",
          binding: {
            token: "inline-token",
            guildId: "__GW_GUILD_ID__",
            agentChannelId: "222",
            logChannelId: "333",
          },
        },
      ],
    } as unknown as Surfaces;
    resolveSurfaceBindingTokens(surfaces);
    expect((surfaces.discord as any)[0].binding.guildId).toBe("000000000000000010");
  });

  test("fail SOFT: unset binding.guildId env → the binding ENTRY is dropped", () => {
    delete process.env.GW_GUILD_ID;
    const surfaces = {
      discord: [
        {
          agent: "pier",
          binding: {
            token: "inline-token",
            guildId: "__GW_GUILD_ID__",
            agentChannelId: "222",
            logChannelId: "333",
          },
        },
      ],
    } as unknown as Surfaces;
    const warnings: SurfaceTokenWarning[] = [];
    expect(() => resolveSurfaceBindingTokens(surfaces, warnings)).not.toThrow();
    expect(surfaces.discord).toHaveLength(0);
    expect(warnings[0]).toMatchObject({
      agent: "pier",
      platform: "discord",
      envVar: "GW_GUILD_ID",
      fieldPath: "surfaces.discord[0].binding.guildId",
    });
  });
});

describe("resolveSurfaceTokensInRawConfig", () => {
  test("walks agents[] and resolves each presence token", () => {
    process.env.VEGA_BOT_TOKEN = "real-vega";
    const raw: Record<string, unknown> = {
      agents: [
        { id: "vega", presence: { discord: { enabled: true, token: "__VEGA_BOT_TOKEN__" } } },
        { id: "luna", presence: { discord: { enabled: true, token: "inline-luna" } } },
      ],
    };
    resolveSurfaceTokensInRawConfig(raw);
    expect((raw.agents as any)[0].presence.discord.token).toBe("real-vega");
    expect((raw.agents as any)[1].presence.discord.token).toBe("inline-luna");
  });

  test("one agent's unset env disables only THAT agent's surface; others untouched", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const raw: Record<string, unknown> = {
      agents: [
        { id: "vega", presence: { discord: { enabled: true, token: "__VEGA_BOT_TOKEN__" } } },
        { id: "luna", presence: { discord: { enabled: true, token: "inline-luna" } } },
      ],
    };
    const warnings: SurfaceTokenWarning[] = [];
    resolveSurfaceTokensInRawConfig(raw, warnings);
    expect((raw.agents as any)[0].presence.discord.enabled).toBe(false);
    expect((raw.agents as any)[1].presence.discord.enabled).toBe(true);
    expect((raw.agents as any)[1].presence.discord.token).toBe("inline-luna");
    expect(warnings.map((w) => w.agent)).toEqual(["vega"]);
  });

  test("no agents[] (legacy bot.yaml shape) → no-op", () => {
    const raw: Record<string, unknown> = { discord: [{ token: "legacy-inline" }] };
    expect(() => resolveSurfaceTokensInRawConfig(raw)).not.toThrow();
    expect((raw.discord as any)[0].token).toBe("legacy-inline");
  });
});

// ===========================================================================
// End-to-end through the loader
// ===========================================================================
describe("loader integration — inline cortex.yaml agents[]", () => {
  let dir: string;
  let personaPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1217-inline-"));
    personaPath = join(dir, "persona.md");
    writeFileSync(personaPath, "# persona\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Two agents so we can assert the rest of the config still loads when one
  // agent's surface token is missing (cortex#1217 blast-radius containment).
  function writeCortexYaml(vegaToken: string): string {
    const cfgPath = join(dir, "cortex.yaml");
    const yaml = `
principal:
  id: andreas
claude:
  timeoutMs: 120000
agents:
  - id: vega
    displayName: Vega
    persona: ${personaPath}
    presence:
      discord:
        enabled: true
        token: ${vegaToken}
        guildId: "111"
        agentChannelId: "222"
        logChannelId: "333"
  - id: luna
    displayName: Luna
    persona: ${personaPath}
    presence:
      discord:
        enabled: true
        token: inline-luna-token
        guildId: "444"
        agentChannelId: "555"
        logChannelId: "666"
`;
    writeFileSync(cfgPath, yaml);
    chmodSync(cfgPath, 0o600);
    return cfgPath;
  }

  test("__VEGA_BOT_TOKEN__ + env set → resolved token reaches the flattened presence", () => {
    process.env.VEGA_BOT_TOKEN = "real-vega-secret";
    const cfgPath = writeCortexYaml("__VEGA_BOT_TOKEN__");
    const loaded = loadConfigWithAgents(cfgPath);
    const vega = loaded.inlineAgents.find((a) => a.id === "vega");
    expect(vega?.presence.discord?.token).toBe("real-vega-secret");
    expect(vega?.presence.discord?.enabled).toBe(true);
    // flattened legacy-shape array (what the adapter loop consumes) too
    const vegaInstance = loaded.config.discord.find((d) => d.token === "real-vega-secret");
    expect(vegaInstance?.enabled).toBe(true);
    expect(loaded.surfaceWarnings).toBeUndefined();
  });

  test("placeholder + UNSET env → surface disabled, NO throw, rest of stack loads", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const cfgPath = writeCortexYaml("__VEGA_BOT_TOKEN__");
    // The whole load must NOT throw (cortex#1217 — this is the crash-loop fix).
    const loaded = loadConfigWithAgents(cfgPath);

    // vega's discord surface is disabled + scrubbed (never the literal).
    const vega = loaded.inlineAgents.find((a) => a.id === "vega");
    expect(vega?.presence.discord?.enabled).toBe(false);
    expect(vega?.presence.discord?.token).not.toBe("__VEGA_BOT_TOKEN__");
    expect(ENV_PLACEHOLDER_PATTERN.test(vega?.presence.discord?.token ?? "")).toBe(false);

    // luna (and the rest of the config) loaded normally.
    const luna = loaded.inlineAgents.find((a) => a.id === "luna");
    expect(luna?.presence.discord?.enabled).toBe(true);
    expect(luna?.presence.discord?.token).toBe("inline-luna-token");

    // bubbled up once, naming the agent + env var.
    expect(loaded.surfaceWarnings).toHaveLength(1);
    expect(loaded.surfaceWarnings?.[0]).toMatchObject({
      agent: "vega",
      platform: "discord",
      envVar: "VEGA_BOT_TOKEN",
    });
  });

  test("NO fail-open: the disabled surface is skipped by the adapter loop (enabled:false)", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const cfgPath = writeCortexYaml("__VEGA_BOT_TOKEN__");
    const loaded = loadConfigWithAgents(cfgPath);
    // The flattened legacy-shape array (`config.discord`) is exactly what the
    // boot-time adapter loop iterates, skipping every `enabled === false`
    // instance before it ever constructs a DiscordAdapter / calls connect().
    // Assert vega's flattened instance is present-but-disabled and carries no
    // literal placeholder.
    const vegaInstance = loaded.config.discord.find((d) => d.guildId === "111");
    expect(vegaInstance).toBeDefined();
    expect(vegaInstance?.enabled).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test(vegaInstance?.token ?? "")).toBe(false);
    // luna's live instance is untouched.
    const lunaInstance = loaded.config.discord.find((d) => d.guildId === "444");
    expect(lunaInstance?.enabled).toBe(true);
  });

  test("inline token → unchanged", () => {
    const cfgPath = writeCortexYaml("inline-discord-token-xyz");
    const loaded = loadConfigWithAgents(cfgPath);
    const vega = loaded.inlineAgents.find((a) => a.id === "vega");
    expect(vega?.presence.discord?.token).toBe("inline-discord-token-xyz");
    expect(vega?.presence.discord?.enabled).toBe(true);
    expect(loaded.surfaceWarnings).toBeUndefined();
  });
});

describe("loader integration — agents.d/ fragment (Pier path)", () => {
  let dir: string;
  let personaPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1217-frag-"));
    personaPath = join(dir, "persona.md");
    writeFileSync(personaPath, "# pier\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writePierFragment(token: string): string {
    const fragPath = join(dir, "pier.yaml");
    const yaml = `
id: pier
displayName: Pier
persona: ${personaPath}
trust: []
presence:
  discord:
    enabled: true
    token: ${token}
    guildId: "000000000000000000"
    agentChannelId: "000000000000000000"
    logChannelId: "000000000000000000"
`;
    writeFileSync(fragPath, yaml);
    return fragPath;
  }

  test("Pier's __PIER_BOT_TOKEN__ resolves identically", () => {
    process.env.PIER_BOT_TOKEN = "real-pier-secret";
    const fragPath = writePierFragment("__PIER_BOT_TOKEN__");
    const agent = loadAgentFromFile(fragPath, dir);
    expect(agent?.presence.discord?.token).toBe("real-pier-secret");
    expect(agent?.presence.discord?.enabled).toBe(true);
  });

  test("Pier fragment placeholder + unset env → loads with discord DISABLED (no throw)", () => {
    delete process.env.PIER_BOT_TOKEN;
    const fragPath = writePierFragment("__PIER_BOT_TOKEN__");
    // cortex#1217 — the fragment loader must NOT throw; the agent loads with its
    // discord surface disabled rather than aborting the whole agents.d/ load.
    const agent = loadAgentFromFile(fragPath, dir);
    expect(agent).not.toBeNull();
    expect(agent?.presence.discord?.enabled).toBe(false);
    expect(agent?.presence.discord?.token).not.toBe("__PIER_BOT_TOKEN__");
    expect(ENV_PLACEHOLDER_PATTERN.test(agent?.presence.discord?.token ?? "")).toBe(false);
  });

  test("inline fragment token → unchanged", () => {
    const fragPath = writePierFragment("inline-pier-token");
    const agent = loadAgentFromFile(fragPath, dir);
    expect(agent?.presence.discord?.token).toBe("inline-pier-token");
    expect(agent?.presence.discord?.enabled).toBe(true);
  });
});

// ===========================================================================
// cortex#1209 review (MAJOR) + cortex#1217 — surfaces.yaml gateway bindings
// ===========================================================================
describe("resolveSurfaceBindingTokens — gateway binding map", () => {
  function surfacesWith(discordToken: string): Surfaces {
    return {
      discord: [
        {
          agent: "vega",
          stack: "andreas/research",
          binding: {
            token: discordToken,
            guildId: "111",
            agentChannelId: "222",
            logChannelId: "333",
          },
        },
      ],
    };
  }

  test("resolves a discord binding.token placeholder from env", () => {
    process.env.GW_DISCORD_TOKEN = "real-gw-token";
    const surfaces = surfacesWith("__GW_DISCORD_TOKEN__");
    resolveSurfaceBindingTokens(surfaces);
    expect((surfaces.discord as any)[0].binding.token).toBe("real-gw-token");
  });

  test("fail SOFT: unset env → the binding ENTRY is dropped (gateway never builds it)", () => {
    delete process.env.GW_DISCORD_TOKEN;
    const surfaces = surfacesWith("__GW_DISCORD_TOKEN__");
    const warnings: SurfaceTokenWarning[] = [];
    expect(() => resolveSurfaceBindingTokens(surfaces, warnings)).not.toThrow();
    // the unresolvable entry is gone — no literal can reach buildGatewayAdapters
    expect(surfaces.discord).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      agent: "vega",
      platform: "discord",
      envVar: "GW_DISCORD_TOKEN",
      fieldPath: "surfaces.discord[0].binding.token",
    });
  });

  test("fail SOFT drops ONLY the unresolvable entry; resolvable siblings survive", () => {
    delete process.env.GW_DISCORD_TOKEN;
    const surfaces = {
      discord: [
        {
          agent: "vega",
          binding: { token: "__GW_DISCORD_TOKEN__", guildId: "1", agentChannelId: "2", logChannelId: "3" },
        },
        {
          agent: "luna",
          binding: { token: "inline-live-token", guildId: "4", agentChannelId: "5", logChannelId: "6" },
        },
      ],
    } as unknown as Surfaces;
    resolveSurfaceBindingTokens(surfaces);
    expect(surfaces.discord).toHaveLength(1);
    expect((surfaces.discord as any)[0].agent).toBe("luna");
    expect((surfaces.discord as any)[0].binding.token).toBe("inline-live-token");
  });

  test("inline binding token → unchanged", () => {
    const surfaces = surfacesWith("inline-gw-token");
    resolveSurfaceBindingTokens(surfaces);
    expect((surfaces.discord as any)[0].binding.token).toBe("inline-gw-token");
  });

  test("resolves slack botToken/appToken + mattermost apiToken bindings", () => {
    process.env.SLACK_BOT = "xoxb-real";
    process.env.SLACK_APP = "xapp-real";
    process.env.MM_API_TOKEN = "mm-real";
    const surfaces = {
      slack: [
        {
          agent: "sage",
          binding: { botToken: "__SLACK_BOT__", appToken: "__SLACK_APP__", workspaceId: "T0123456789" },
        },
      ],
      mattermost: [
        { agent: "echo", binding: { apiUrl: "https://mm.example.com", apiToken: "__MM_API_TOKEN__" } },
      ],
    } as unknown as Surfaces;
    resolveSurfaceBindingTokens(surfaces);
    expect((surfaces.slack as any)[0].binding.botToken).toBe("xoxb-real");
    expect((surfaces.slack as any)[0].binding.appToken).toBe("xapp-real");
    expect((surfaces.mattermost as any)[0].binding.apiToken).toBe("mm-real");
  });

  test("fail SOFT: a missing slack botToken drops the slack binding", () => {
    delete process.env.SLACK_BOT;
    process.env.SLACK_APP = "xapp-real";
    const surfaces = {
      slack: [
        {
          agent: "sage",
          binding: { botToken: "__SLACK_BOT__", appToken: "__SLACK_APP__", workspaceId: "T0123456789" },
        },
      ],
    } as unknown as Surfaces;
    const warnings: SurfaceTokenWarning[] = [];
    resolveSurfaceBindingTokens(surfaces, warnings);
    expect(surfaces.slack).toHaveLength(0);
    expect(warnings[0]?.platform).toBe("slack");
    expect(warnings[0]?.envVar).toBe("SLACK_BOT");
  });
});

describe("assertNoUnresolvedPlaceholder (belt-and-suspenders, retained strict path)", () => {
  test("throws naming the env var on a literal placeholder", () => {
    expect(() => assertNoUnresolvedPlaceholder("__GW_DISCORD_TOKEN__", "x")).toThrow(/GW_DISCORD_TOKEN/);
  });
  test("the thrown type is still EnvPlaceholderError", () => {
    expect(() => assertNoUnresolvedPlaceholder("__GW_DISCORD_TOKEN__", "x")).toThrow(EnvPlaceholderError);
  });
  test("passes a resolved / inline value", () => {
    expect(() => assertNoUnresolvedPlaceholder("real-token", "x")).not.toThrow();
    expect(() => assertNoUnresolvedPlaceholder(undefined, "x")).not.toThrow();
  });
  test("passes a disabled-surface scrub sentinel (it is not a placeholder)", () => {
    expect(() => assertNoUnresolvedPlaceholder("xoxb-DISABLED-SLACK_BOT", "x")).not.toThrow();
    expect(() => assertNoUnresolvedPlaceholder("DISABLED-MISSING-SECRET-VEGA_BOT_TOKEN", "x")).not.toThrow();
  });
});

// ===========================================================================
// End-to-end: a surfaces.yaml directory layout resolves binding tokens into
// LoadedConfig.surfaces (the object the gateway consumes).
// ===========================================================================
describe("loader integration — surfaces.yaml directory layout (gateway path)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1217-surfaces-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function systemBlocks(): Record<string, unknown> {
    return {
      claude: { timeoutMs: 300000 },
      paths: { publishedEventsDir: "/tmp/events/published", logDir: "/tmp/cortex/logs" },
    };
  }

  function writeLayout(discordToken: string): string {
    mkdirSync(join(dir, "system"), { recursive: true });
    writeFileSync(join(dir, "system", "system.yaml"), stringify(systemBlocks()));
    mkdirSync(join(dir, "surfaces"), { recursive: true });
    writeFileSync(
      join(dir, "surfaces", "surfaces.yaml"),
      stringify({
        surfaces: {
          discord: [
            {
              agent: "vega",
              stack: "andreas/research",
              binding: {
                token: discordToken,
                guildId: "111",
                agentChannelId: "222",
                logChannelId: "333",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "stacks"), { recursive: true });
    const persona = join(dir, "vega.md");
    writeFileSync(persona, "# vega\n");
    writeFileSync(
      join(dir, "stacks", "research.yaml"),
      stringify({
        principal: { id: "andreas" },
        agents: [{ id: "vega", displayName: "Vega", persona, trust: [], presence: {} }],
      }),
    );
    return join(dir, "cortex.yaml");
  }

  test("placeholder in surfaces.yaml binding resolves into LoadedConfig.surfaces with env set", () => {
    process.env.GW_DISCORD_TOKEN = "real-gw-secret";
    const loaded = loadConfigWithAgents(writeLayout("__GW_DISCORD_TOKEN__"));
    expect((loaded.surfaces?.discord as any)?.[0]?.binding.token).toBe("real-gw-secret");
    expect(loaded.surfaceWarnings).toBeUndefined();
  });

  test("placeholder in surfaces.yaml binding + unset env → binding dropped, NO throw", () => {
    delete process.env.GW_DISCORD_TOKEN;
    const loaded = loadConfigWithAgents(writeLayout("__GW_DISCORD_TOKEN__"));
    // the gateway map drops the unresolvable binding (no literal survives)
    expect(loaded.surfaces?.discord ?? []).toHaveLength(0);
    expect(loaded.surfaceWarnings).toHaveLength(1);
    expect(loaded.surfaceWarnings?.[0]).toMatchObject({
      platform: "discord",
      envVar: "GW_DISCORD_TOKEN",
    });
  });
});

// ===========================================================================
// cortex#1217 review (MAJOR) — agents.d/ FRAGMENT disabled-surface warnings
// must be COLLECTED into the sink (vega is a fragment), not only emitted to
// stderr, so they reach the consolidated boot banner.
// ===========================================================================
describe("loadAgentsDirectory — fragment disabled-surface warnings reach the sink", () => {
  let dir: string;
  let agentsDir: string;
  let personaPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1217-fragdir-"));
    agentsDir = join(dir, "agents.d");
    mkdirSync(agentsDir, { recursive: true });
    personaPath = join(dir, "persona.md");
    writeFileSync(personaPath, "# persona\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeFragment(id: string, token: string): void {
    writeFileSync(
      join(agentsDir, `${id}.yaml`),
      `
id: ${id}
displayName: ${id}
persona: ${personaPath}
trust: []
presence:
  discord:
    enabled: true
    token: ${token}
    guildId: "111"
    agentChannelId: "222"
    logChannelId: "333"
`,
    );
  }

  test("vega fragment with unset token → warning is COLLECTED (not just stderr) + surface disabled", () => {
    delete process.env.VEGA_BOT_TOKEN;
    writeFragment("vega", "__VEGA_BOT_TOKEN__");
    // an enabled, inline-token sibling fragment that loads fine
    writeFragment("luna", "inline-luna-token");

    const warnings: SurfaceTokenWarning[] = [];
    const agents = loadAgentsDirectory(agentsDir, warnings);

    // both fragment agents still load (no throw, no aborted directory load)
    expect(agents.map((a) => a.id).sort()).toEqual(["luna", "vega"]);
    const vega = agents.find((a) => a.id === "vega");
    expect(vega?.presence.discord?.enabled).toBe(false);

    // the disabled-surface warning reached the sink → it can reach the banner
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      agent: "vega",
      platform: "discord",
      envVar: "VEGA_BOT_TOKEN",
    });
  });
});

// ===========================================================================
// cortex#1217 review (NIT 2) — boot-loop no-fail-open lock.
//
// Reproduce the EXACT instance list + gate the boot path builds/uses
// (`src/cortex.ts`: `discordInstances = [...config.discord,
// ...flattenDiscordPresences(fragmentOnlyAgents)]`, then
// `for (const instance of discordInstances) { if (!surfaceInstanceEnabled(...))
// continue; new DiscordAdapter(...).start() }`). A `construct` spy stands in for
// `new DiscordAdapter` / `.start()`/`connect()`. Asserts a fail-soft-disabled
// surface is `continue`d past BEFORE construction — locking the guarantee at the
// boot level, not just the resolver level.
// ===========================================================================
describe("boot adapter loop — disabled surface is skipped BEFORE construct/connect", () => {
  let dir: string;
  let agentsDir: string;
  let personaPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1217-bootloop-"));
    agentsDir = join(dir, "agents.d");
    mkdirSync(agentsDir, { recursive: true });
    personaPath = join(dir, "persona.md");
    writeFileSync(personaPath, "# persona\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeInlineCortexYaml(): string {
    const cfgPath = join(dir, "cortex.yaml");
    // luna: inline token → enabled. vega: placeholder + (unset env) → disabled.
    writeFileSync(
      cfgPath,
      `
principal:
  id: andreas
claude:
  timeoutMs: 120000
agents:
  - id: luna
    displayName: Luna
    persona: ${personaPath}
    presence:
      discord:
        enabled: true
        token: inline-luna-token
        guildId: "444"
        agentChannelId: "555"
        logChannelId: "666"
  - id: vega
    displayName: Vega
    persona: ${personaPath}
    presence:
      discord:
        enabled: true
        token: __VEGA_BOT_TOKEN__
        guildId: "111"
        agentChannelId: "222"
        logChannelId: "333"
`,
    );
    chmodSync(cfgPath, 0o600);
    return cfgPath;
  }

  test("the gate skips every disabled instance before the adapter is constructed", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const cfgPath = writeInlineCortexYaml();
    const loaded = loadConfigWithAgents(cfgPath);

    // Faithfully reconstruct the boot path's instance list (cortex.ts ~3634).
    const inlineIds = new Set(loaded.inlineAgents.map((a) => a.id));
    const fragmentOnlyAgents: Agent[] = loadAgentsDirectory(agentsDir).filter(
      (a) => !inlineIds.has(a.id),
    );
    const discordInstances = [
      ...loaded.config.discord,
      ...flattenDiscordPresences(fragmentOnlyAgents),
    ];

    // `construct` stands in for `new DiscordAdapter(...).start()` (which would
    // call `client.login(token)` → connect). It must NEVER run for a disabled
    // instance, and must never receive a literal placeholder.
    const constructed: { guildId: string; token: string }[] = [];
    const connectAttempts: string[] = [];
    for (const instance of discordInstances) {
      // EXACT production gate (cortex.ts: `if (!surfaceInstanceEnabled(instance))`).
      if (!surfaceInstanceEnabled(instance)) continue;
      // Past the gate ⇒ the adapter would be constructed + login attempted.
      constructed.push({ guildId: instance.guildId, token: instance.token });
      connectAttempts.push(instance.token);
    }

    // luna (enabled) was constructed; vega (disabled) was skipped before construct.
    expect(constructed.map((c) => c.guildId)).toEqual(["444"]);
    expect(constructed.map((c) => c.token)).toEqual(["inline-luna-token"]);

    // No connect attempt ever carried the literal placeholder OR vega's scrubbed
    // sentinel — the disabled surface never reached connect at all.
    expect(connectAttempts).not.toContain("__VEGA_BOT_TOKEN__");
    for (const t of connectAttempts) {
      expect(ENV_PLACEHOLDER_PATTERN.test(t)).toBe(false);
    }

    // Sanity: vega's instance IS present in the list but gated off (enabled:false)
    // and carries no literal — proving the gate, not absence, is what protects it.
    const vegaInstance = loaded.config.discord.find((d) => d.guildId === "111");
    expect(vegaInstance?.enabled).toBe(false);
    expect(surfaceInstanceEnabled(vegaInstance ?? { enabled: true })).toBe(false);
    expect(ENV_PLACEHOLDER_PATTERN.test(vegaInstance?.token ?? "")).toBe(false);
  });
});

// ===========================================================================
// compass#84 (L2) — `.example` template fragments stay INVISIBLE to the loader.
//
// The structural-hygiene convention is that a shippable path holds either a
// `.example` template (zeroed IDs / `__ENV__` placeholders / `<REPLACE_ME>`) or
// a generic fragment. `loadAgentsDirectory` filters to `*.yaml`/`*.yml`, so a
// `pier.yaml.example` is never loaded — its zeroed/placeholder content can never
// disable a live surface or serialize into test/boot output. This regression
// pins that invariant: if a future refactor of `listYamlFiles` widened the
// filter to include `.example`, this test fails loudly.
// ===========================================================================
describe("loadAgentsDirectory — `.example` fragments are invisible (compass#84 L2)", () => {
  let dir: string;
  let agentsDir: string;
  let personaPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c84-example-"));
    agentsDir = join(dir, "agents.d");
    mkdirSync(agentsDir, { recursive: true });
    personaPath = join(dir, "persona.md");
    writeFileSync(personaPath, "# persona\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a *.yaml.example template is not loaded; a sibling *.yaml is", () => {
    // A real, loadable fragment.
    writeFileSync(
      join(agentsDir, "real.yaml"),
      `
id: real
displayName: Real
persona: ${personaPath}
trust: []
presence:
  discord:
    enabled: true
    token: inline-token
    guildId: "000000000000000000"
    agentChannelId: "000000000000000000"
    logChannelId: "000000000000000000"
`,
    );
    // A `.example` template carrying `__ENV__` placeholders + zeroed IDs. If the
    // loader ever picked this up, the unresolved `__EXAMPLE_*__` placeholders
    // would (post-compass#84) DISABLE a surface / emit warnings — so a green
    // assertion here also proves the template never reached the resolver.
    writeFileSync(
      join(agentsDir, "pier.yaml.example"),
      `
id: pier
displayName: Pier
persona: ${personaPath}
trust: []
presence:
  discord:
    enabled: true
    token: __EXAMPLE_BOT_TOKEN__
    guildId: __EXAMPLE_GUILD_ID__
    agentChannelId: __EXAMPLE_AGENT_CHANNEL_ID__
    logChannelId: __EXAMPLE_LOG_CHANNEL_ID__
`,
    );

    const warnings: SurfaceTokenWarning[] = [];
    const agents = loadAgentsDirectory(agentsDir, warnings);

    // Only the real fragment loads; the `.example` is invisible.
    expect(agents.map((a) => a.id)).toEqual(["real"]);
    // The `.example` placeholders never reached the resolver ⇒ no disabled-surface warnings.
    expect(warnings).toHaveLength(0);
  });
});
