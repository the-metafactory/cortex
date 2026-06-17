import { describe, test, expect } from "bun:test";
import { buildSecurityPreamble } from "../security-preamble";
import type { AgentConfig } from "../../common/types/config";

function makeConfig(overrides: Partial<AgentConfig["claude"]> = {}): AgentConfig {
  return {
    agent: { name: "test", displayName: "Test" },
    discord: {
      token: "t",
      guildId: "g",
      agentChannelId: "a",
      logChannelId: "l",
      contextDepth: 10,
      roles: [],
    },
    mattermost: { enabled: false, url: "", token: "", teamName: "", channels: [] },
    claude: {
      model: "sonnet",
      maxTurns: 10,
      additionalArgs: [],
      allowedTools: [],
      disallowedTools: [],
      allowedDirs: [],
      timeoutMs: 120000,
      ...overrides,
    },
    attachments: { enabled: true, maxSizeMb: 10, allowedTypes: [] },
    paths: {
      publishedEventsDir: "~/.claude/events/published",
      claudeMdPath: "",
    },
  } as unknown as AgentConfig;
}

describe("buildSecurityPreamble", () => {
  test("always includes config immutability rule", () => {
    const preamble = buildSecurityPreamble(makeConfig());
    expect(preamble).toContain("CONFIG IMMUTABILITY");
    expect(preamble).toContain("cortex.yaml");
    expect(preamble).toContain("MUST NOT");
  });

  test("uses provided configPath directory in immutability rule", () => {
    const preamble = buildSecurityPreamble(
      makeConfig(),
      "/home/user/.config/cortex/cortex.yaml",
    );
    expect(preamble).toContain("/home/user/.config/cortex");
  });

  test("defaults to ~/.config/cortex when no configPath (GV-1 cortex#1076 — config-path migration)", () => {
    const preamble = buildSecurityPreamble(makeConfig());
    expect(preamble).toContain("~/.config/cortex");
    expect(preamble).not.toContain("~/.config/grove");
  });

  test("includes filesystem restriction when allowedDirs configured", () => {
    const preamble = buildSecurityPreamble(
      makeConfig({ allowedDirs: ["~/work/mf"] }),
    );
    expect(preamble).toContain("FILESYSTEM RESTRICTION");
    expect(preamble).toContain("~/work/mf");
    expect(preamble).toContain("CONFIG IMMUTABILITY");
  });

  test("references cortex.yaml and 'agent' / 'principal', not bot.yaml / 'the bot'", () => {
    const preamble = buildSecurityPreamble(
      makeConfig(),
      "/home/user/.config/cortex/cortex.yaml",
    );
    expect(preamble).toContain("cortex.yaml");
    expect(preamble).not.toContain("bot.yaml");
    expect(preamble).not.toMatch(/\bthe bot\b/);
    expect(preamble).toContain("the principal");
    expect(preamble).toContain("the agent");
    // Cascade-coverage: when an explicit cortex.yaml path is provided, the
    // GROVE_* → CORTEX_* namespace cascade (handled elsewhere) must NOT leak a
    // `~/.config/grove` hint through this preamble. Guards against regression
    // where the runtime path falls back to the legacy directory string.
    expect(preamble).not.toContain("~/.config/grove");
  });

  test("includes security policy wrapper", () => {
    const preamble = buildSecurityPreamble(makeConfig());
    expect(preamble).toContain("[SECURITY POLICY");
    expect(preamble).toContain("[END SECURITY POLICY]");
  });
});
