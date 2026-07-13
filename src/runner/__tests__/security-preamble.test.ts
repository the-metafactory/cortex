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

  // XDG wave-4 (cortex#1869): with no configPath the immutability rule names the
  // RESOLVED config dir via the seam. Pin CORTEX_CONFIG_DIR so the resolver
  // returns it verbatim (short-circuiting real-home probing → hermetic) and the
  // assertion is deterministic across hosts.
  test("defaults to the resolved cortex config dir when no configPath (XDG wave-4 cortex#1869)", () => {
    const prev = process.env.CORTEX_CONFIG_DIR;
    process.env.CORTEX_CONFIG_DIR = "/scratch/xdg-preamble/metafactory/cortex";
    try {
      const preamble = buildSecurityPreamble(makeConfig());
      expect(preamble).toContain("/scratch/xdg-preamble/metafactory/cortex");
      expect(preamble).not.toContain("~/.config/grove");
    } finally {
      if (prev === undefined) delete process.env.CORTEX_CONFIG_DIR;
      else process.env.CORTEX_CONFIG_DIR = prev;
    }
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
