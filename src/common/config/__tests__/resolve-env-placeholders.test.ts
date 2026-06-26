/**
 * cortex#1209 — `__ENV__` placeholder resolution for surface secret fields.
 *
 * Acceptance cases (from the issue):
 *   - `token: __VEGA_BOT_TOKEN__` + env set → adapter receives the real token.
 *   - placeholder + unset env → fatal, env-var-named error (NOT the literal).
 *   - inline token → unchanged.
 *   - Pier's `__PIER_BOT_TOKEN__` resolves the same way (fragment path).
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
});

describe("resolveAgentPresenceTokens", () => {
  test("resolves a discord token placeholder from env", () => {
    process.env.VEGA_BOT_TOKEN = "real-vega-token";
    const agent: Record<string, unknown> = {
      presence: { discord: { token: "__VEGA_BOT_TOKEN__" } },
    };
    resolveAgentPresenceTokens(agent, "agents[0]");
    expect((agent.presence as any).discord.token).toBe("real-vega-token");
  });

  test("fail-closed: unset env → EnvPlaceholderError naming the var, not the literal", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const agent: Record<string, unknown> = {
      presence: { discord: { token: "__VEGA_BOT_TOKEN__" } },
    };
    let err: unknown;
    try {
      resolveAgentPresenceTokens(agent, "agents[0]");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvPlaceholderError);
    expect((err as EnvPlaceholderError).envVar).toBe("VEGA_BOT_TOKEN");
    expect((err as Error).message).toContain("VEGA_BOT_TOKEN");
    expect((err as Error).message).toContain("agents[0].presence.discord.token");
    // the literal placeholder must NOT silently survive onto the object
    expect((agent.presence as any).discord.token).toBe("__VEGA_BOT_TOKEN__");
  });

  test("fail-closed: EMPTY env var is treated as unset", () => {
    process.env.VEGA_BOT_TOKEN = "";
    const agent: Record<string, unknown> = {
      presence: { discord: { token: "__VEGA_BOT_TOKEN__" } },
    };
    expect(() => resolveAgentPresenceTokens(agent, "agents[0]")).toThrow(EnvPlaceholderError);
  });

  test("inline token passes through byte-identical", () => {
    const agent: Record<string, unknown> = {
      presence: { discord: { token: "inline-real-token-123" } },
    };
    resolveAgentPresenceTokens(agent, "agents[0]");
    expect((agent.presence as any).discord.token).toBe("inline-real-token-123");
  });

  test("resolves mattermost.apiToken + slack.botToken/appToken", () => {
    process.env.MM_API_TOKEN = "mm-real";
    process.env.SLACK_BOT = "xoxb-real";
    process.env.SLACK_APP = "xapp-real";
    const agent: Record<string, unknown> = {
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

describe("resolveSurfaceTokensInRawConfig", () => {
  test("walks agents[] and resolves each presence token", () => {
    process.env.VEGA_BOT_TOKEN = "real-vega";
    const raw: Record<string, unknown> = {
      agents: [
        { id: "vega", presence: { discord: { token: "__VEGA_BOT_TOKEN__" } } },
        { id: "luna", presence: { discord: { token: "inline-luna" } } },
      ],
    };
    resolveSurfaceTokensInRawConfig(raw);
    expect((raw.agents as any)[0].presence.discord.token).toBe("real-vega");
    expect((raw.agents as any)[1].presence.discord.token).toBe("inline-luna");
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
    dir = mkdtempSync(join(tmpdir(), "c1209-inline-"));
    personaPath = join(dir, "persona.md");
    writeFileSync(personaPath, "# persona\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeCortexYaml(token: string): string {
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
        token: ${token}
        guildId: "111"
        agentChannelId: "222"
        logChannelId: "333"
`;
    writeFileSync(cfgPath, yaml);
    chmodSync(cfgPath, 0o600);
    return cfgPath;
  }

  test("__VEGA_BOT_TOKEN__ + env set → resolved token reaches the flattened presence", () => {
    process.env.VEGA_BOT_TOKEN = "real-vega-secret";
    const cfgPath = writeCortexYaml("__VEGA_BOT_TOKEN__");
    const loaded = loadConfigWithAgents(cfgPath);
    expect(loaded.inlineAgents[0]?.presence.discord?.token).toBe("real-vega-secret");
    // flattened legacy-shape array (what the adapter loop consumes) too
    expect(loaded.config.discord[0]?.token).toBe("real-vega-secret");
  });

  test("placeholder + unset env → fatal error naming the var, never the literal", () => {
    delete process.env.VEGA_BOT_TOKEN;
    const cfgPath = writeCortexYaml("__VEGA_BOT_TOKEN__");
    expect(() => loadConfigWithAgents(cfgPath)).toThrow(/VEGA_BOT_TOKEN/);
    expect(() => loadConfigWithAgents(cfgPath)).toThrow(EnvPlaceholderError);
  });

  test("inline token → unchanged", () => {
    const cfgPath = writeCortexYaml("inline-discord-token-xyz");
    const loaded = loadConfigWithAgents(cfgPath);
    expect(loaded.inlineAgents[0]?.presence.discord?.token).toBe("inline-discord-token-xyz");
  });
});

describe("loader integration — agents.d/ fragment (Pier path)", () => {
  let dir: string;
  let personaPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1209-frag-"));
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
  });

  test("Pier fragment placeholder + unset env → fatal, env-var-named", () => {
    delete process.env.PIER_BOT_TOKEN;
    const fragPath = writePierFragment("__PIER_BOT_TOKEN__");
    expect(() => loadAgentFromFile(fragPath, dir)).toThrow(/PIER_BOT_TOKEN/);
  });

  test("inline fragment token → unchanged", () => {
    const fragPath = writePierFragment("inline-pier-token");
    const agent = loadAgentFromFile(fragPath, dir);
    expect(agent?.presence.discord?.token).toBe("inline-pier-token");
  });
});

// ===========================================================================
// cortex#1209 review — whitespace-only env (nit 1)
// ===========================================================================
describe("fail-closed on whitespace-only env (nit 1)", () => {
  test("env var set to '   ' is treated as unset → fatal", () => {
    process.env.VEGA_BOT_TOKEN = "   ";
    const agent: Record<string, unknown> = {
      presence: { discord: { token: "__VEGA_BOT_TOKEN__" } },
    };
    expect(() => resolveAgentPresenceTokens(agent, "agents[0]")).toThrow(EnvPlaceholderError);
  });
});

// ===========================================================================
// cortex#1209 review (MAJOR) — surfaces.yaml gateway-binding resolution
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

  test("fail-closed: unset env → EnvPlaceholderError naming the var (not the literal)", () => {
    delete process.env.GW_DISCORD_TOKEN;
    const surfaces = surfacesWith("__GW_DISCORD_TOKEN__");
    let err: unknown;
    try {
      resolveSurfaceBindingTokens(surfaces);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EnvPlaceholderError);
    expect((err as EnvPlaceholderError).envVar).toBe("GW_DISCORD_TOKEN");
    expect((err as Error).message).toContain("surfaces.discord[0].binding.token");
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
});

describe("assertNoUnresolvedPlaceholder (belt-and-suspenders)", () => {
  test("throws naming the env var on a literal placeholder", () => {
    expect(() => assertNoUnresolvedPlaceholder("__GW_DISCORD_TOKEN__", "x")).toThrow(/GW_DISCORD_TOKEN/);
  });
  test("passes a resolved / inline value", () => {
    expect(() => assertNoUnresolvedPlaceholder("real-token", "x")).not.toThrow();
    expect(() => assertNoUnresolvedPlaceholder(undefined, "x")).not.toThrow();
  });
});

// ===========================================================================
// End-to-end: a surfaces.yaml directory layout resolves binding tokens into
// LoadedConfig.surfaces (the object the gateway consumes).
// ===========================================================================
describe("loader integration — surfaces.yaml directory layout (gateway path)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c1209-surfaces-"));
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
  });

  test("placeholder in surfaces.yaml binding + unset env → fatal, env-var-named", () => {
    delete process.env.GW_DISCORD_TOKEN;
    expect(() => loadConfigWithAgents(writeLayout("__GW_DISCORD_TOKEN__"))).toThrow(/GW_DISCORD_TOKEN/);
  });
});
