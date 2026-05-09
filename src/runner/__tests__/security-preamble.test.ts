import { describe, test, expect } from "bun:test";
import { buildSecurityPreamble } from "../security-preamble";
import type { BotConfig } from "../../common/types/config";

function makeConfig(overrides: Partial<BotConfig["claude"]> = {}): BotConfig {
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
  } as unknown as BotConfig;
}

describe("buildSecurityPreamble", () => {
  test("always includes config immutability rule", () => {
    const preamble = buildSecurityPreamble(makeConfig());
    expect(preamble).toContain("CONFIG IMMUTABILITY");
    expect(preamble).toContain("bot.yaml");
    expect(preamble).toContain("MUST NOT");
  });

  test("uses provided configPath directory in immutability rule", () => {
    const preamble = buildSecurityPreamble(
      makeConfig(),
      "/home/user/.config/grove/bot.yaml",
    );
    expect(preamble).toContain("/home/user/.config/grove");
  });

  test("defaults to ~/.config/grove when no configPath", () => {
    const preamble = buildSecurityPreamble(makeConfig());
    expect(preamble).toContain("~/.config/grove");
  });

  test("includes filesystem restriction when allowedDirs configured", () => {
    const preamble = buildSecurityPreamble(
      makeConfig({ allowedDirs: ["~/work/mf"] }),
    );
    expect(preamble).toContain("FILESYSTEM RESTRICTION");
    expect(preamble).toContain("~/work/mf");
    expect(preamble).toContain("CONFIG IMMUTABILITY");
  });

  test("includes security policy wrapper", () => {
    const preamble = buildSecurityPreamble(makeConfig());
    expect(preamble).toContain("[SECURITY POLICY");
    expect(preamble).toContain("[END SECURITY POLICY]");
  });
});
