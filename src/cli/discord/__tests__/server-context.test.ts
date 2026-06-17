/**
 * Unit tests for the multi-server resolution helper.
 *
 * The `discord` CLI was single-guild: one top-level guildId + channels map.
 * `resolveServerContext` layers two complementary overrides over that base —
 * a `--guild <id>` flag and a `--server <name>` named profile — with the
 * precedence `--guild`/`--channel` > `--server` profile > top-level config.
 *
 * These tests pin that precedence and, critically, the back-compat invariant:
 * with no flags the resolved context is identical to the top-level config so
 * the legacy single-guild path is untouched.
 */

import { describe, expect, test } from "bun:test";
import type { DiscordCliConfig } from "../lib/config";
import {
  cachedChannelId,
  resolveServerContext,
  registerServerProfile,
  ServerContextError,
} from "../lib/server-context";

// Real guild IDs from the deployment: grove (top-level) + halden (profile).
const GROVE_GUILD = "1487023327791808592";
const HALDEN_GUILD = "1512054429023731884";

function baseConfig(): DiscordCliConfig {
  return {
    botToken: "grove-token",
    guildId: GROVE_GUILD,
    defaultChannel: "cortex",
    channels: { cortex: { id: "111" } },
    servers: {
      halden: {
        guildId: HALDEN_GUILD,
        defaultChannel: "general",
        channels: { general: { id: "1512054429480648837" } },
      },
    },
  };
}

describe("resolveServerContext — back-compat (no flags)", () => {
  test("no flags resolves to the top-level config verbatim", () => {
    const config = baseConfig();
    const ctx = resolveServerContext(config, {});
    expect(ctx.guildId).toBe(GROVE_GUILD);
    expect(ctx.botToken).toBe("grove-token");
    expect(ctx.defaultChannel).toBe("cortex");
    expect(ctx.channels).toEqual({ cortex: { id: "111" } });
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD);
    expect(ctx.serverName).toBeUndefined();
  });

  test("no flags on a minimal config (no servers block) is unchanged", () => {
    const config: DiscordCliConfig = {
      botToken: "t",
      guildId: GROVE_GUILD,
      defaultChannel: "cortex",
    };
    const ctx = resolveServerContext(config, {});
    expect(ctx.guildId).toBe(GROVE_GUILD);
    expect(ctx.botToken).toBe("t");
    expect(ctx.defaultChannel).toBe("cortex");
    expect(ctx.channelsGuildId).toBeUndefined();
  });
});

describe("resolveServerContext — --guild flag (ISC-C2/C3)", () => {
  test("--guild overrides guildId for name resolution", () => {
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD);
  });

  test("--guild keeps the top-level token and channels but marks their owner", () => {
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(ctx.botToken).toBe("grove-token");
    expect(ctx.channels).toEqual({ cortex: { id: "111" } });
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD);
    expect(ctx.serverName).toBeUndefined();
  });
});

describe("resolveServerContext — --server profile (ISC-C7/C8)", () => {
  test("--server overrides guildId with the profile's guildId", () => {
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.serverName).toBe("halden");
  });

  test("--server uses the profile's defaultChannel and channels", () => {
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(ctx.defaultChannel).toBe("general");
    expect(ctx.channels).toEqual({ general: { id: "1512054429480648837" } });
    expect(ctx.channelsGuildId).toBe(HALDEN_GUILD);
  });

  test("--server falls back to top-level token/channel and preserves channel owner", () => {
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    expect(ctx.botToken).toBe("grove-token"); // fell back to top-level
    expect(ctx.defaultChannel).toBe("cortex"); // fell back to top-level
    expect(ctx.channels).toEqual({ cortex: { id: "111" } });
    expect(ctx.channelsGuildId).toBe(GROVE_GUILD);
  });

  test("--server uses the profile's own token when present", () => {
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD, botToken: "halden-token" } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(ctx.botToken).toBe("halden-token");
  });
});

describe("resolveServerContext — precedence (ISC-C9)", () => {
  test("--guild beats the --server profile guildId when they agree-or-not", () => {
    const config = baseConfig();
    // profile resolves to HALDEN, but explicit --guild wins for guildId.
    const ctx = resolveServerContext(config, { server: "halden", guild: HALDEN_GUILD });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
    // profile's channels/defaultChannel still layered in.
    expect(ctx.defaultChannel).toBe("general");
    expect(ctx.channelsGuildId).toBe(HALDEN_GUILD);
  });
});

describe("cachedChannelId — guild-scoped channel cache (cortex#1030)", () => {
  test("no flags can use the top-level channel cache", () => {
    const ctx = resolveServerContext(baseConfig(), {});
    expect(cachedChannelId(ctx, "cortex")).toBe("111");
  });

  test("--guild cannot use a top-level cache owned by another guild", () => {
    const ctx = resolveServerContext(baseConfig(), { guild: HALDEN_GUILD });
    expect(cachedChannelId(ctx, "cortex")).toBeUndefined();
  });

  test("--guild can use the top-level cache when the guild still matches", () => {
    const ctx = resolveServerContext(baseConfig(), { guild: GROVE_GUILD });
    expect(cachedChannelId(ctx, "cortex")).toBe("111");
  });

  test("--server can use its own profile channel cache", () => {
    const ctx = resolveServerContext(baseConfig(), { server: "halden" });
    expect(cachedChannelId(ctx, "general")).toBe("1512054429480648837");
  });

  test("--server without profile channels cannot use inherited top-level cache", () => {
    const config = baseConfig();
    config.servers = { halden: { guildId: HALDEN_GUILD } };
    const ctx = resolveServerContext(config, { server: "halden" });
    expect(cachedChannelId(ctx, "cortex")).toBeUndefined();
  });

  test("matching --server and --guild can still use the profile cache", () => {
    const ctx = resolveServerContext(baseConfig(), {
      server: "halden",
      guild: HALDEN_GUILD,
    });
    expect(cachedChannelId(ctx, "general")).toBe("1512054429480648837");
  });

  test("unknown channel names miss the cache", () => {
    const ctx = resolveServerContext(baseConfig(), {});
    expect(cachedChannelId(ctx, "unknown")).toBeUndefined();
  });
});

describe("resolveServerContext — error paths (ISC-C11/C12)", () => {
  test("unknown --server profile throws loudly", () => {
    expect(() => resolveServerContext(baseConfig(), { server: "nope" })).toThrow(
      ServerContextError
    );
  });

  test("profile missing guildId fails loudly", () => {
    const config = baseConfig();
    // Simulate a hand-edited profile with no guildId.
    config.servers = { broken: { guildId: "" } };
    expect(() => resolveServerContext(config, { server: "broken" })).toThrow(
      /missing guildId/
    );
  });

  test("conflicting --guild and --server (different guilds) errors clearly", () => {
    expect(() =>
      resolveServerContext(baseConfig(), { server: "halden", guild: GROVE_GUILD })
    ).toThrow(/Conflicting guild/);
  });

  test("matching --guild and --server (same guild) does NOT error", () => {
    const ctx = resolveServerContext(baseConfig(), {
      server: "halden",
      guild: HALDEN_GUILD,
    });
    expect(ctx.guildId).toBe(HALDEN_GUILD);
  });

  test("error messages never include the bot token", () => {
    try {
      resolveServerContext(baseConfig(), { server: "nope" });
    } catch (err) {
      expect((err as Error).message).not.toContain("grove-token");
    }
  });
});

describe("registerServerProfile (ISC-C13)", () => {
  test("registers a new profile with guildId only", () => {
    const config: DiscordCliConfig = { botToken: "t", guildId: GROVE_GUILD };
    registerServerProfile(config, "halden", HALDEN_GUILD);
    expect(config.servers?.halden?.guildId).toBe(HALDEN_GUILD);
  });

  test("registers a profile with a default channel", () => {
    const config: DiscordCliConfig = {};
    registerServerProfile(config, "halden", HALDEN_GUILD, "general");
    expect(config.servers?.halden?.defaultChannel).toBe("general");
  });

  test("updating an existing profile preserves its cached channels", () => {
    const config: DiscordCliConfig = {
      servers: { halden: { guildId: "old", channels: { general: { id: "999" } } } },
    };
    registerServerProfile(config, "halden", HALDEN_GUILD);
    expect(config.servers?.halden?.guildId).toBe(HALDEN_GUILD);
    expect(config.servers?.halden?.channels).toEqual({ general: { id: "999" } });
  });

  test("never writes a token onto the profile", () => {
    const config: DiscordCliConfig = {};
    registerServerProfile(config, "halden", HALDEN_GUILD, "general");
    expect(config.servers?.halden?.botToken).toBeUndefined();
  });

  test("empty guildId throws", () => {
    const config: DiscordCliConfig = {};
    expect(() => registerServerProfile(config, "halden", "")).toThrow(ServerContextError);
  });
});
