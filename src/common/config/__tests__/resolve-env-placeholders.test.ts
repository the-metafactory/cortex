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
import { loadConfigWithAgents, loadAgentFromFile } from "../loader";

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
    guildId: "1505549701674700991"
    agentChannelId: "1517154685595942972"
    logChannelId: "1514679294553751613"
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
