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
  distinctBoundStacks,
  distinctBoundPrincipalStacks,
  crossPrincipalBindings,
  type GatewayBindingIndex,
  type GatewayBindingMatch,
} from "../binding-resolver";
import type { Surfaces } from "../../common/types/surfaces";
import type { InboundMessage } from "../../adapters/types";
import { testRegistryWithWeb } from "./test-registry-support";

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
        guildId: "555555555555555555",
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
    expect(index.discord.has("555555555555555555")).toBe(true);
  });

  test("slack: indexes by workspaceId", () => {
    const index = buildBindingIndex(SLACK_SURFACES);
    expect(index.slack.size).toBe(1);
    expect(index.slack.has("T0123456789")).toBe(true);
  });

  test("mattermost single: single-binding slot is populated", () => {
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES, testRegistryWithWeb());
    expect(index.mattermostSingle).not.toBeNull();
    expect(index.mattermostMulti).toBe(false);
  });

  test("mattermost multi: multi-binding ambiguity flag is set", () => {
    const index = buildBindingIndex(MATTERMOST_MULTI_SURFACES, testRegistryWithWeb());
    expect(index.mattermostSingle).toBeNull();
    expect(index.mattermostMulti).toBe(true);
  });

  test("all platforms combined: each platform section is indexed", () => {
    const combined: Surfaces = {
      discord: DISCORD_SURFACES.discord,
      slack: SLACK_SURFACES.slack,
      mattermost: MATTERMOST_SINGLE_SURFACES.mattermost,
    };
    const index = buildBindingIndex(combined, testRegistryWithWeb());
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
    const inbound = msg({ platform: "discord", guildId: "555555555555555555" });
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
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES, testRegistryWithWeb());
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
    const inbound = msg({ platform: "discord", guildId: "555555555555555555" });
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
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES, testRegistryWithWeb());
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
    const index = buildBindingIndex(MATTERMOST_MULTI_SURFACES, testRegistryWithWeb());
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
      msg({ platform: "discord", guildId: "555555555555555555" }),
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
      msg({ platform: "discord", guildId: "555555555555555555" }),
    );
    const m2 = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "555555555555555555", content: "different content" }),
    );
    expect(m1!.instance).toBe(m2!.instance);
  });

  test("instance is 'platform:demuxKey' format (interim until schema carries explicit id)", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const match = resolveBinding(
      index,
      msg({ platform: "discord", guildId: "555555555555555555" }),
    );
    expect(match!.instance).toBe("discord:555555555555555555");
  });

  test("mattermost single-binding: instance is 'mattermost:apiUrl'", () => {
    const index = buildBindingIndex(MATTERMOST_SINGLE_SURFACES, testRegistryWithWeb());
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
    const inbound = msg({ platform: "teams", guildId: "555555555555555555" });
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

// ─── 13. distinctBoundStacks (a.3d outbound subjects) ─────────────────────────

describe("distinctBoundStacks — gateway outbound subject derivation", () => {
  test("single binding → its parsed stack leaf", () => {
    expect(distinctBoundStacks(DISCORD_SURFACES)).toEqual(["meta-factory"]);
  });

  test("distinct stacks across platforms, deduped, in iteration order", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "ivy",
          stack: "andreas/research",
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
      slack: [
        {
          agent: "luna",
          // same leaf as the first discord binding → collapses to one entry
          stack: "andreas/meta-factory",
          binding: { botToken: "xoxb", appToken: "xapp", workspaceId: "W1" },
        },
      ],
      mattermost: [
        {
          agent: "forge",
          // a third, mattermost-only leaf → exercises the mattermost loop
          stack: "andreas/ops",
          binding: { apiUrl: "https://mm.example.com", apiToken: "mm-tok" },
        },
      ],
    };
    expect(distinctBoundStacks(surfaces)).toEqual([
      "meta-factory",
      "research",
      "ops",
    ]);
  });

  test("gap-4 binding (no stack field) → a single `undefined` entry", () => {
    const noStack: Surfaces = {
      discord: [
        {
          agent: "luna",
          // no `stack:` — gap 4
          binding: { token: "t", guildId: "G", agentChannelId: "a", logChannelId: "b" },
        },
      ],
    };
    expect(distinctBoundStacks(noStack)).toEqual([undefined]);
  });

  test("mixed stacked + gap-4 bindings → leaf plus one undefined", () => {
    const mixed: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "ivy",
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
    };
    expect(distinctBoundStacks(mixed)).toEqual(["meta-factory", undefined]);
  });

  test("no bindings → empty list", () => {
    expect(distinctBoundStacks({})).toEqual([]);
  });
});

// ─── 13b. distinctBoundPrincipalStacks (F-1 multi-principal — cortex#629) ──────

describe("distinctBoundPrincipalStacks — multi-principal subject derivation", () => {
  test("single binding → one (principal, stack) pair from its parsed stack", () => {
    expect(distinctBoundPrincipalStacks(DISCORD_SURFACES, "andreas")).toEqual([
      { principal: "andreas", stack: "meta-factory" },
    ]);
  });

  test("bindings under DIFFERENT principals → one pair each, own principal preserved", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "robin",
          // a second principal on the shared bus
          stack: "robin/research",
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
    };
    // gateway principal "andreas"; the "robin" binding keeps its OWN principal
    // (NOT collapsed onto the gateway principal).
    expect(distinctBoundPrincipalStacks(surfaces, "andreas")).toEqual([
      { principal: "andreas", stack: "meta-factory" },
      { principal: "robin", stack: "research" },
    ]);
  });

  test("same (principal, stack) across platforms → deduped to one pair", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
      ],
      slack: [
        {
          agent: "luna",
          // identical (principal, stack) → collapses
          stack: "andreas/meta-factory",
          binding: { botToken: "xoxb", appToken: "xapp", workspaceId: "W1" },
        },
      ],
    };
    expect(distinctBoundPrincipalStacks(surfaces, "andreas")).toEqual([
      { principal: "andreas", stack: "meta-factory" },
    ]);
  });

  test("same stack LEAF under different principals → two distinct pairs (not collapsed)", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/research",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "robin",
          // SAME leaf "research", DIFFERENT principal → must NOT dedup
          stack: "robin/research",
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
    };
    expect(distinctBoundPrincipalStacks(surfaces, "andreas")).toEqual([
      { principal: "andreas", stack: "research" },
      { principal: "robin", stack: "research" },
    ]);
  });

  test("gap-4 binding (no stack field) → gateway principal + undefined stack", () => {
    const noStack: Surfaces = {
      discord: [
        {
          agent: "luna",
          binding: { token: "t", guildId: "G", agentChannelId: "a", logChannelId: "b" },
        },
      ],
    };
    expect(distinctBoundPrincipalStacks(noStack, "andreas")).toEqual([
      { principal: "andreas", stack: undefined },
    ]);
  });

  test("mixed: stacked cross-principal + gap-4 → pair plus the gateway-principal undefined bucket", () => {
    const mixed: Surfaces = {
      discord: [
        {
          agent: "robin",
          stack: "robin/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "luna",
          // gap-4 → gateway principal "andreas", undefined stack
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
    };
    expect(distinctBoundPrincipalStacks(mixed, "andreas")).toEqual([
      { principal: "robin", stack: "meta-factory" },
      { principal: "andreas", stack: undefined },
    ]);
  });

  test("two gap-4 bindings → a single gateway-principal undefined bucket (dedup)", () => {
    const twoGap4: Surfaces = {
      discord: [
        {
          agent: "luna",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "ivy",
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
    };
    expect(distinctBoundPrincipalStacks(twoGap4, "andreas")).toEqual([
      { principal: "andreas", stack: undefined },
    ]);
  });

  test("no bindings → empty list", () => {
    expect(distinctBoundPrincipalStacks({}, "andreas")).toEqual([]);
  });
});

// ─── 14. crossPrincipalBindings (single-principal v1 enforcement) ──────────────

describe("crossPrincipalBindings — single-principal v1 guard", () => {
  test("all bindings under the gateway principal → no offenders", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
      ],
      slack: [
        {
          agent: "ivy",
          stack: "andreas/research",
          binding: { botToken: "xoxb", appToken: "xapp", workspaceId: "W1" },
        },
      ],
    };
    expect(crossPrincipalBindings(surfaces, "andreas")).toEqual([]);
  });

  test("a binding under another principal → flagged (across all platforms)", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
      ],
      mattermost: [
        {
          agent: "forge",
          stack: "someone-else/ops",
          binding: { apiUrl: "https://mm.example.com", apiToken: "mm-tok" },
        },
      ],
    };
    expect(crossPrincipalBindings(surfaces, "andreas")).toEqual(["someone-else/ops"]);
  });

  test("gap-4 binding (no stack / no principal) is never flagged", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          // no stack → no principal → cannot be cross-principal
          binding: { token: "t", guildId: "G", agentChannelId: "a", logChannelId: "b" },
        },
      ],
    };
    expect(crossPrincipalBindings(surfaces, "andreas")).toEqual([]);
  });

  test("duplicate offending stack ids collapse to one", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "a",
          stack: "other/x",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
        {
          agent: "b",
          stack: "other/x",
          binding: { token: "t2", guildId: "G2", agentChannelId: "c", logChannelId: "d" },
        },
      ],
    };
    expect(crossPrincipalBindings(surfaces, "andreas")).toEqual(["other/x"]);
  });
});

// ─── Web platform coverage (C-110 / WEB-1 gateway routing fix) ───────────────
//
// The web adapter was added by WEB-1 but the gateway's binding-presence guards
// and inbound router were not taught about the `web` platform until this fix.
// These tests pin the newly-wired paths so a future refactor can't silently
// drop them again.

/** One web binding — instanceId "acme" → demux key "web:acme". */
const WEB_SURFACES: Surfaces = {
  web: [
    {
      agent: "pylon",
      stack: "andreas/acme",
      binding: {
        host: "127.0.0.1",
        instanceId: "acme",
        port: 8090,
        broadcastUrl: "http://localhost:9090/broadcast",
        transport: "ws",
        authScheme: "cf-access",
      },
    },
  ],
};

describe("buildBindingIndex — web happy path", () => {
  test("web: indexes by instanceId prefixed with 'web:'", () => {
    const index = buildBindingIndex(WEB_SURFACES, testRegistryWithWeb());
    expect(index.web.size).toBe(1);
    expect(index.web.has("web:acme")).toBe(true);
  });

  test("web entry carries agent, principal, stack, and instance from fixture", () => {
    const index = buildBindingIndex(WEB_SURFACES, testRegistryWithWeb());
    const entry = index.web.get("web:acme");
    expect(entry).toBeDefined();
    expect(entry!.agent).toBe("pylon");
    expect(entry!.principal).toBe("andreas");
    expect(entry!.stack).toBe("acme");
    expect(entry!.instance).toBe("web:acme");
  });

  test("empty surfaces: web map is empty (web key present with size 0)", () => {
    const index = buildBindingIndex({});
    expect(index.web.size).toBe(0);
  });
});

describe("buildBindingIndex — web collision throws", () => {
  test("two web bindings sharing the same instanceId → throws with instanceId in message", () => {
    const ambiguous: Surfaces = {
      web: [
        {
          agent: "pylon",
          stack: "andreas/acme",
          binding: {
            host: "127.0.0.1",
            instanceId: "acme",
            port: 8090,
            broadcastUrl: "http://localhost:9090/broadcast",
            transport: "ws",
            authScheme: "cf-access",
          },
        },
        {
          agent: "relay",
          stack: "andreas/work",
          binding: {
            host: "127.0.0.1",
            instanceId: "acme", // duplicate — same demux key "web:acme"
            port: 8091,
            broadcastUrl: "http://localhost:9091/broadcast",
            transport: "ws",
            authScheme: "cf-access",
          },
        },
      ],
    };
    expect(() => buildBindingIndex(ambiguous, testRegistryWithWeb())).toThrow(/web.*acme/i);
  });
});

describe("resolveBinding — web happy path", () => {
  test("web: resolves by instanceId (full 'web:<id>' key stamped by the WebAdapter)", () => {
    const index = buildBindingIndex(WEB_SURFACES, testRegistryWithWeb());
    // The WebAdapter stamps instanceId="web:acme" on every inbound message
    const inbound = msg({ platform: "web", instanceId: "web:acme" });
    const match = resolveBinding(index, inbound);
    expect(match).not.toBeNull();
    expect(match!.platform).toBe("web");
    expect(match!.agent).toBe("pylon");
    expect(match!.principal).toBe("andreas");
    expect(match!.stack).toBe("acme");
    expect(match!.instance).toBe("web:acme");
  });

  test("web: instanceId not in index → null", () => {
    const index = buildBindingIndex(WEB_SURFACES, testRegistryWithWeb());
    const inbound = msg({ platform: "web", instanceId: "web:unknown" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });

  test("web inbound against discord-only index → null (web map is empty)", () => {
    const index = buildBindingIndex(DISCORD_SURFACES);
    const inbound = msg({ platform: "web", instanceId: "web:acme" });
    expect(resolveBinding(index, inbound)).toBeNull();
  });
});

describe("distinctBoundStacks — web bindings", () => {
  test("web-only surfaces: includes the web binding's stack leaf", () => {
    expect(distinctBoundStacks(WEB_SURFACES)).toEqual(["acme"]);
  });

  test("web stack deduped when the same leaf appears in both discord and web", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/acme",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
      ],
      web: [
        {
          agent: "pylon",
          stack: "andreas/acme", // same leaf — collapses to one entry
          binding: {
            host: "127.0.0.1",
            instanceId: "acme",
            port: 8090,
            broadcastUrl: "http://localhost:9090/broadcast",
            transport: "ws",
            authScheme: "cf-access",
          },
        },
      ],
    };
    expect(distinctBoundStacks(surfaces)).toEqual(["acme"]);
  });

  test("web adds a distinct stack leaf beyond discord's set", () => {
    const surfaces: Surfaces = {
      discord: [
        {
          agent: "luna",
          stack: "andreas/meta-factory",
          binding: { token: "t1", guildId: "G1", agentChannelId: "a", logChannelId: "b" },
        },
      ],
      web: [
        {
          agent: "pylon",
          stack: "andreas/acme",
          binding: {
            host: "127.0.0.1",
            instanceId: "acme",
            port: 8090,
            broadcastUrl: "http://localhost:9090/broadcast",
            transport: "ws",
            authScheme: "cf-access",
          },
        },
      ],
    };
    expect(distinctBoundStacks(surfaces)).toEqual(["meta-factory", "acme"]);
  });
});

describe("crossPrincipalBindings — web bindings", () => {
  test("web binding under the gateway principal → no offenders", () => {
    expect(crossPrincipalBindings(WEB_SURFACES, "andreas")).toEqual([]);
  });

  test("web binding under another principal → flagged", () => {
    const surfaces: Surfaces = {
      web: [
        {
          agent: "pylon",
          stack: "other/acme",
          binding: {
            host: "127.0.0.1",
            instanceId: "acme",
            port: 8090,
            broadcastUrl: "http://localhost:9090/broadcast",
            transport: "ws",
            authScheme: "cf-access",
          },
        },
      ],
    };
    expect(crossPrincipalBindings(surfaces, "andreas")).toEqual(["other/acme"]);
  });
});
