/**
 * cortex#524 GW.a.1 — binding resolver tests (TDD Red→Green).
 *
 * Tests cover:
 *
 *   1. buildBindingIndex — happy path per platform
 *   2. buildBindingIndex — ambiguous collision throws loudly
 *   3. resolveBinding — happy path per platform
 *   4. resolveBinding — no-platform-bindings → null
 *   5. resolveBinding — no-match on demux key → null
 *   6. resolveBinding — DM / no guildId → null
 *   7. resolveBinding — mattermost single-binding fallback
 *   8. resolveBinding — mattermost multi-binding → null (unresolvable-by-inbound)
 *   9. stack-parsing — with and without `stack` field
 *  10. instance-id determinism — (platform, demuxKey) → stable string
 */

import { describe, expect, test } from "bun:test";
import {
  buildBindingIndex,
  resolveBinding,
  type GatewayBindingIndex,
  type GatewayBindingMatch,
} from "../binding-resolver";
import type { Surfaces } from "../../common/types/surfaces";
import type { InboundMessage } from "../../adapters/types";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

/** Minimal valid InboundMessage for tests that only care about routing fields */
function msg(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    platform: "discord",
    instanceId: "test-instance",
    authorId: "u1",
    authorName: "Test User",
    content: "hello",
    channelId: "ch1",
    attachments: [],
    timestamp: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Minimal valid Surfaces — one discord binding */
const DISCORD_SURFACES: Surfaces = {
  discord: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        token: "tok-luna-discord",
        guildId: "111222333444555666",
        agentChannelId: "aaa000000000000001",
        logChannelId: "bbb000000000000002",
      },
    },
  ],
};

/** Minimal valid Surfaces — one slack binding */
const SLACK_SURFACES: Surfaces = {
  slack: [
    {
      agent: "luna",
      stack: "andreas/meta-factory",
      binding: {
        botToken: "xoxb-111-222-abc",
        appToken: "xapp-1-333-444-def",
        workspaceId: "T0123456789",
      },
    },
  ],
};

/** Mattermost single binding (resolvable by single-binding fallback) */
const MATTERMOST_SINGLE_SURFACES: Surfaces = {
  mattermost: [
    {
      agent: "luna",
      stack: "andreas/work",
      binding: {
        apiUrl: "https://mm.example.com",
        apiToken: "mm-tok-abc",
      },
    },
  ],
};

/** Mattermost two bindings (unresolvable-by-inbound — no per-message server id) */
const MATTERMOST_MULTI_SURFACES: Surfaces = {
  mattermost: [
    {
      agent: "luna",
      stack: "andreas/work",
      binding: {
        apiUrl: "https://mm.work.example.com",
        apiToken: "mm-tok-work",
      },
    },
    {
      agent: "echo",
      stack: "andreas/meta-factory",
      binding: {
        apiUrl: "https://mm.mf.example.com",
        apiToken: "mm-tok-mf",
      },
    },
  ],
};

// ─── 1. buildBindingIndex — happy path per platform ──────────────────────────

describe("buildBindingIndex — happy path", () => {
  test("discord: indexes by guildId", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    expect(index.discord.size).toBe(1);
    expect(index.discord.has("111222333444555666")).toBe(true);
  });

  test("slack: indexes by workspaceId", () => {
    const index = buildBindingIndex(SLACK_SURFACES);
    expect(index.slack.size).toBe(1);
    expect(index.slack.has("T0123456789")).toBe(true);
  });

  test("mattermost single: single-binding slot is populated", () => {
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES);
    expect(index.mattermostSingle).not.toBeNull();
    expect(index.mattermostMulti).toBe(false);
  });

  test("mattermost multi: multi-binding ambiguity flag is set", () => {
    const index = buildBindingIndex(MATTERMOST_MULTI_SURFACES);
    expect(index.mattermostSingle).toBeNull();
    expect(index.mattermostMulti).toBe(true);
  });

  test("all platforms combined: each platform section is indexed", () => {
    const combined: Surfaces = {
      discord: DISCORD_SURFACES.discord,
      slack: SLACK_SURFACES.slack,
      mattermost: MATTERMOST_SINGLE_SURFACES.mattermost,
    };
    const index = buildBindingIndex(combined);
    expect(index.discord.size).toBe(1);
    expect(index.slack.size).toBe(1);
    expect(index.mattermostSingle).not.toBeNull();
  });

  test("empty surfaces: produces empty index with no bindings", () => {
    const index = buildBindingIndex({});
    expect(index.discord.size).toBe(0);
    expect(index.slack.size).toBe(0);
    expect(index.mattermostSingle).toBeNull();
    expect(index.mattermostMulti).toBe(false);
  });
});

// ─── 2. buildBindingIndex — ambiguous collision throws loudly ─────────────────

describe("buildBindingIndex — collision throws", () => {
  test("discord: two bindings with same guildId → throws with platform + key in message", () => {
    const ambiguous: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: {
            token: "tok-luna",
            guildId: "SAME_GUILD",
            agentChannelId: "aaa",
            logChannelId: "bbb",
          },
        },
        {
          agent: "echo",
          stack: "andreas/work",
          binding: {
            token: "tok-echo",
            guildId: "SAME_GUILD",
            agentChannelId: "ccc",
            logChannelId: "ddd",
          },
        },
      ],
    };
    expect(() => buildBindingIndex(ambiguous)).toThrow(/discord.*SAME_GUILD/i);
  });

  test("slack: two bindings with same workspaceId → throws with platform + key in message", () => {
    const ambiguous: Surfaces = {
      slack: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: {
            botToken: "xoxb-1-2-abc",
            appToken: "xapp-1-2-def",
            workspaceId: "TSAMESPACE",
          },
        },
        {
          agent: "echo",
          stack: "andreas/work",
          binding: {
            botToken: "xoxb-3-4-ghi",
            appToken: "xapp-3-4-jkl",
            workspaceId: "TSAMESPACE",
          },
        },
      ],
    };
    expect(() => buildBindingIndex(ambiguous)).toThrow(/slack.*TSAMESPACE/i);
  });
});

// ─── 3. resolveBinding — happy path per platform ─────────────────────────────

describe("resolveBinding — happy path", () => {
  test("discord: resolves by guildId", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const inbound = msg({ platform: "discord", guildId: "111222333444555666" });
    const match = resolveBinding(index, inbound);
    expect(match).not.toBeNull();
    expect(match!.platform).toBe("discord");
    expect(match!.agent).toBe("luna");
    expect(match!.principal).toBe("andreas");
    expect(match!.stack).toBe("meta-factory");
  });

  test("slack: resolves by workspaceId", () => {
    const index = buildBindingIndex(SLACK_SURFACES);
    const inbound = msg({ platform: "slack", guildId: "T0123456789" });
    const match = resolveBinding(index, inbound);
    expect(match).not.toBeNull();
    expect(match!.platform).toBe("slack");
    expect(match!.agent).toBe("luna");
  });

  test("mattermost single: resolves by fallback", () => {
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES);
    const inbound = msg({ platform: "mattermost", guildId: undefined });
    const match = resolveBinding(index, inbound);
    expect(match).not.toBeNull();
    expect(match!.platform).toBe("mattermost");
    expect(match!.agent).toBe("luna");
    expect(match!.principal).toBe("andreas");
    expect(match!.stack).toBe("work");
  });
});

// ─── 4. resolveBinding — no-platform-bindings → null ─────────────────────────

describe("resolveBinding — no platform bindings", () => {
  test("discord inbound against slack-only index → null", () => {
    const index = buildBindingIndex(SLACK_SURFACES);
    const inbound = msg({ platform: "discord", guildId: "111222333444555666" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });

  test("completely empty index → null", () => {
    const index = buildBindingIndex({});
    const inbound = msg({ platform: "discord", guildId: "any" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });
});

// ─── 5. resolveBinding — no-match on demux key → null ────────────────────────

describe("resolveBinding — no-match on demux key", () => {
  test("discord: guildId not in index → null", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const inbound = msg({ platform: "discord", guildId: "999999999999999999" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });

  test("slack: workspaceId not in index → null", () => {
    const index = buildBindingIndex(SLACK_SURFACES);
    const inbound = msg({ platform: "slack", guildId: "TNOMATCH12" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });
});

// ─── 6. resolveBinding — DM / no guildId → null ──────────────────────────────

describe("resolveBinding — DM / no guildId", () => {
  test("discord DM (no guildId) → null (guild-granularity only in v1)", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const inbound = msg({ platform: "discord", guildId: undefined, isDM: true });
    expect(resolveBinding(index, inbound)).toBeNull();
  });

  test("slack DM (no guildId / workspaceId) → null", () => {
    const index = buildBindingIndex(SLACK_SURFACES);
    const inbound = msg({ platform: "slack", guildId: undefined, isDM: true });
    expect(resolveBinding(index, inbound)).toBeNull();
  });
});

// ─── 7. mattermost — single-binding fallback resolves ────────────────────────
// (covered in §3 above; this section adds the no-guildId-field variant)

describe("resolveBinding — mattermost single-binding", () => {
  test("resolves even when guildId is absent (no per-message server id on mattermost)", () => {
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES);
    // Build without guildId to confirm the Mattermost single-binding fallback
    // does not require a demux key on the inbound message.
    const inbound = msg({ platform: "mattermost", guildId: undefined });
    const match = resolveBinding(index, inbound);
    expect(match).not.toBeNull();
    expect(match!.platform).toBe("mattermost");
  });
});

// ─── 8. mattermost multi-binding → null (unresolvable-by-inbound) ────────────

describe("resolveBinding — mattermost multi-binding ambiguity", () => {
  test("returns null (no per-message server id to discriminate)", () => {
    const index = buildBindingIndex(MATTERMOST_MULTI_SURFACES);
    const inbound = msg({ platform: "mattermost", guildId: undefined });
    expect(resolveBinding(index, inbound)).toBeNull();
  });
});

// ─── 9. stack-parsing ─────────────────────────────────────────────────────────

describe("stack-parsing", () => {
  test("binding with stack='andreas/meta-factory' → principal=andreas, stack=meta-factory", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const match = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "111222333444555666" }),
    );
    expect(match!.principal).toBe("andreas");
    expect(match!.stack).toBe("meta-factory");
  });

  test("binding without stack field → principal and stack are undefined", () => {
    const noStack: Surfaces = {
      discord: [
        {
          agent: "luna",
          // no stack field
          binding: {
            token: "tok-luna-nostck",
            guildId: "GUILD_NO_STACK",
            agentChannelId: "aaa",
            logChannelId: "bbb",
          },
        },
      ],
    };
    const index = buildBindingIndex(noStack);
    const match = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "GUILD_NO_STACK" }),
    );
    expect(match).not.toBeNull();
    expect(match!.principal).toBeUndefined();
    expect(match!.stack).toBeUndefined();
  });

  test("binding with stack='x/y/z' (extra slashes) → principal=x, stack=y/z (rest)", () => {
    const multiSlash: Surfaces = {
      discord: [
        {
          agent: "forge",
          stack: "x/y/z",
          binding: {
            token: "tok-forge",
            guildId: "GUILD_XSLASH",
            agentChannelId: "eee",
            logChannelId: "fff",
          },
        },
      ],
    };
    const index = buildBindingIndex(multiSlash);
    const match = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "GUILD_XSLASH" }),
    );
    expect(match!.principal).toBe("x");
    expect(match!.stack).toBe("y/z");
  });
});

// ─── 10. instance-id determinism ──────────────────────────────────────────────

describe("instance-id determinism", () => {
  test("same (platform, guildId) always produces the same instance string", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const m1 = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "111222333444555666" }),
    );
    const m2 = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "111222333444555666", content: "different content" }),
    );
    expect(m1!.instance).toBe(m2!.instance);
  });

  test("instance is 'platform:demuxKey' format (interim until schema carries explicit id)", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const match = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "111222333444555666" }),
    );
    expect(match!.instance).toBe("discord:111222333444555666");
  });

  test("mattermost single-binding: instance is 'mattermost:apiUrl'", () => {
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES);
    const match = resolveBinding(index, msg({ platform: "mattermost" }));
    expect(match!.instance).toBe("mattermost:https://mm.example.com");
  });

  test("different guildIds produce different instance ids", () => {
    const twoGuilds: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: {
            token: "tok-a",
            guildId: "GUILD_A",
            agentChannelId: "a1",
            logChannelId: "a2",
          },
        },
        {
          agent: "echo",
          stack: "andreas/work",
          binding: {
            token: "tok-b",
            guildId: "GUILD_B",
            agentChannelId: "b1",
            logChannelId: "b2",
          },
        },
      ],
    };
    const index = buildBindingIndex(twoGuilds);
    const mA = resolveBinding(index, msg({ platform: "discord", guildId: "GUILD_A" }));
    const mB = resolveBinding(index, msg({ platform: "discord", guildId: "GUILD_B" }));
    expect(mA!.instance).not.toBe(mB!.instance);
    expect(mA!.instance).toBe("discord:GUILD_A");
    expect(mB!.instance).toBe("discord:GUILD_B");
  });
});

// ─── 11. unknown platform (the fallthrough safety net) ────────────────────────

describe("resolveBinding — unknown platform", () => {
  test("a platform with no resolver branch (e.g. 'teams') → null", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    // InboundMessage.platform is typed `string`, so a future/unknown platform
    // is representable; the resolver must fall through to null, never throw.
    const inbound = msg({ platform: "teams", guildId: "111222333444555666" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });
});

// ─── 12. degenerate stack strings ─────────────────────────────────────────────

describe("stack-parsing — degenerate inputs collapse to undefined", () => {
  test("stack='/' (admitted by .min(1)) → principal and stack are undefined", () => {
    const loneSlash: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "/",
          binding: {
            token: "tok-luna-slash",
            guildId: "GUILD_SLASH",
            agentChannelId: "ccc",
            logChannelId: "ddd",
          },
        },
      ],
    };
    const index = buildBindingIndex(loneSlash);
    const match = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "GUILD_SLASH" }),
    );
    expect(match).not.toBeNull();
    expect(match!.principal).toBeUndefined();
    expect(match!.stack).toBeUndefined();
  });
});
