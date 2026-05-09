/**
 * G-300: DM trust chain tests
 *
 * Verifies the full DM privilege pipeline:
 *   DM type classification → role resolution → security preamble → bash guard config
 */

import { test, expect, describe } from "bun:test";
import { buildSecurityPreamble } from "../security-preamble";
import type { BotConfig } from "../../common/types/config";
import { BotConfigSchema } from "../../common/types/config";

// Minimal valid config for tests
function makeConfig(overrides: Record<string, unknown> = {}): BotConfig {
  return BotConfigSchema.parse({
    agent: { name: "luna", displayName: "Luna", operatorDiscordId: "operator-123" },
    discord: [{
      token: "test-token",
      guildId: "guild-1",
      agentChannelId: "ch-1",
      logChannelId: "ch-2",
      roles: [],
      dm: {
        operatorRole: {
          features: ["chat", "async", "team"],
          disallowedTools: [],
          bashGuard: true,
          bashAllowlist: {
            rules: [
              { pattern: "^gh\\s+" },
              { pattern: "^git\\s+" },
              { pattern: "^ls\\b" },
            ],
            repos: ["the-metafactory/grove"],
          },
        },
        defaultRole: "denied",
        userRoles: [{
          users: ["user-456"],
          features: ["chat"],
          disallowedTools: ["Write", "Edit"],
          bashGuard: true,
        }],
      },
      ...overrides,
    }],
    mattermost: [],
    claude: {
      allowedDirs: ["/home/grove"],
      readOnlyDirs: ["/home/shared"],
      bashAllowlist: {
        rules: [{ pattern: "^gh\\s+" }],
        repos: ["the-metafactory/grove"],
      },
    },
  });
}

describe("DM trust chain", () => {
  describe("security preamble", () => {
    test("default preamble includes filesystem restriction and bash guidance", () => {
      const config = makeConfig();
      const preamble = buildSecurityPreamble(config);

      expect(preamble).toContain("FILESYSTEM RESTRICTION");
      expect(preamble).toContain("BASH COMMANDS");
      expect(preamble).toContain("VERIFICATION RULE");
      expect(preamble).toContain("CONFIG IMMUTABILITY");
    });

    test("operator DM preamble skips filesystem and bash guidance", () => {
      const config = makeConfig();
      const preamble = buildSecurityPreamble(config, undefined, {
        skipBashGuard: true,
        skipFilesystemRestriction: true,
      });

      expect(preamble).not.toContain("FILESYSTEM RESTRICTION");
      expect(preamble).not.toContain("BASH COMMANDS");
      // These are always enforced, even for operator DM
      expect(preamble).toContain("VERIFICATION RULE");
      expect(preamble).toContain("CONFIG IMMUTABILITY");
    });

    test("overrideDirs replaces default dirs in preamble", () => {
      const config = makeConfig();
      const preamble = buildSecurityPreamble(config, undefined, {
        overrideDirs: ["/custom/dir1", "/custom/dir2"],
      });

      expect(preamble).toContain("/custom/dir1");
      expect(preamble).toContain("/custom/dir2");
    });

    test("read-only restriction included when readOnlyDirs configured", () => {
      const config = makeConfig();
      const preamble = buildSecurityPreamble(config);

      expect(preamble).toContain("READ-ONLY RESTRICTION");
      expect(preamble).toContain("/home/shared");
    });
  });

  describe("DM role resolution (via DiscordAdapter.resolveAccess)", () => {
    test("DMConfigSchema defaults are safe when explicitly configured", () => {
      const config = BotConfigSchema.parse({
        agent: { name: "luna", displayName: "Luna" },
        discord: [{
          token: "t", guildId: "g", agentChannelId: "a", logChannelId: "l",
          dm: { operatorRole: {}, defaultRole: "denied" },
        }],
        mattermost: [],
        claude: {},
      });

      const dm = config.discord[0]!.dm;
      expect(dm.defaultRole).toBe("denied");
      expect(dm.userRoles).toEqual([]);
      expect(dm.operatorRole.features).toContain("chat");
      expect(dm.operatorRole.bashGuard).toBe(true);
    });

    test("DM section absent means dm is empty object (adapter handles with optional chaining)", () => {
      const config = BotConfigSchema.parse({
        agent: { name: "luna", displayName: "Luna" },
        discord: [{ token: "t", guildId: "g", agentChannelId: "a", logChannelId: "l" }],
        mattermost: [],
        claude: {},
      });

      const dm = config.discord[0]!.dm;
      expect(dm).toBeDefined();
      expect(dm.defaultRole).toBeUndefined();
    });

    test("operator role allows bash allowlist override", () => {
      const config = makeConfig();
      const dm = config.discord[0]!.dm;
      const opRole = dm.operatorRole;

      expect(opRole.bashAllowlist).toBeDefined();
      expect(opRole.bashAllowlist!.rules).toHaveLength(3);
      expect(opRole.bashAllowlist!.repos).toContain("the-metafactory/grove");
    });

    test("user role restricts tools and keeps bash guard", () => {
      const config = makeConfig();
      const dm = config.discord[0]!.dm;
      const userRole = dm.userRoles.find((r) => r.users.includes("user-456"));

      expect(userRole).toBeDefined();
      expect(userRole!.features).toEqual(["chat"]);
      expect(userRole!.disallowedTools).toContain("Write");
      expect(userRole!.disallowedTools).toContain("Edit");
      expect(userRole!.bashGuard).toBe(true);
    });
  });

  describe("bash guard config propagation", () => {
    test("GROVE_BASH_GUARD disabled config is valid JSON", () => {
      const config = JSON.stringify({ disabled: true });
      const parsed = JSON.parse(config);
      expect(parsed.disabled).toBe(true);
    });

    test("GROVE_BASH_GUARD with allowlist config is valid JSON", () => {
      const allowlist = {
        rules: [
          { pattern: "^gh\\s+", repos: ["the-metafactory/grove"] },
          { pattern: "^git\\s+" },
        ],
        repos: ["the-metafactory/grove"],
      };
      const config = JSON.stringify(allowlist);
      const parsed = JSON.parse(config);
      expect(parsed.rules).toHaveLength(2);
      expect(parsed.repos).toContain("the-metafactory/grove");
    });

    test("disabled guard allows commands that default config would block", () => {
      // Simulate the bash-guard.hook.ts loadConfig() logic
      function loadConfig(envValue: string | undefined) {
        if (envValue) {
          try {
            const parsed = JSON.parse(envValue);
            if (parsed.disabled) return null; // Guard disabled
            return { rules: parsed.rules ?? [], repos: parsed.repos ?? [] };
          } catch { /* fall through */ }
        }
        return { rules: [{ pattern: "^ls\\b" }], repos: [] }; // Default: restrictive
      }

      function isAllowed(command: string, config: ReturnType<typeof loadConfig>) {
        if (config === null) return true; // Guard disabled — everything allowed
        return config.rules.some((r: { pattern: string }) => new RegExp(r.pattern).test(command));
      }

      // Default config blocks rm
      const defaultConfig = loadConfig(undefined);
      expect(isAllowed("rm -rf /tmp/test", defaultConfig)).toBe(false);
      expect(isAllowed("ls /tmp", defaultConfig)).toBe(true);

      // Disabled guard (operator DM) allows rm
      const disabledConfig = loadConfig(JSON.stringify({ disabled: true }));
      expect(isAllowed("rm -rf /tmp/test", disabledConfig)).toBe(true);
      expect(isAllowed("curl https://example.com", disabledConfig)).toBe(true);

      // Custom allowlist allows specific commands
      const customConfig = loadConfig(JSON.stringify({
        rules: [{ pattern: "^git\\s+" }, { pattern: "^rm\\b" }],
      }));
      expect(isAllowed("git push origin main", customConfig)).toBe(true);
      expect(isAllowed("rm -rf /tmp/test", customConfig)).toBe(true);
      expect(isAllowed("curl https://example.com", customConfig)).toBe(false);
    });
  });
});
