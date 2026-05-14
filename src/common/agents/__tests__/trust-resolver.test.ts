/**
 * MIG-7.2b — TrustResolver tests.
 *
 * Covers:
 *   - Construction over an AgentRegistry
 *   - register / unregister semantics + idempotent reconnect
 *   - Fail-closed: unknown agent id at register throws AgentNotFoundError
 *   - Identity-claim refusal: re-register to a different agent throws
 *   - Forward + reverse lookup helpers
 *   - Full trust check by platform identity (the actual call path
 *     receiving adapters use)
 *   - Multi-platform per agent (Discord + Mattermost simultaneously)
 *   - Unregister cleanup (forward + reverse indexes drop entries)
 */

import { describe, test, expect, beforeEach } from "bun:test";

import {
  AgentNotFoundError,
  AgentRegistry,
} from "../registry";
import {
  PlatformIdAlreadyRegisteredError,
  TrustResolver,
  type Platform,
} from "../trust-resolver";
import type { Agent } from "../../types/cortex-config";

// =============================================================================
// Fixtures
// =============================================================================

function discordPresence() {
  return {
    enabled: true,
    token: "discord-bot-token",
    guildId: "1487000000000000000",
    agentChannelId: "1487000000000000001",
    logChannelId: "1487000000000000002",
    contextDepth: 10,
    enableAgentLog: false,
    roles: [],
    defaultRole: "allow-all",
    dm: {
      operatorRole: {
        features: ["chat", "async", "team"] as const,
        disallowedTools: [],
        bashGuard: true,
      },
      defaultRole: "denied" as const,
      userRoles: [],
    },
  };
}

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    roles: [],
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function registryOf(...agents: Agent[]): AgentRegistry {
  return AgentRegistry.fromAgents(agents);
}

// Some plausible-looking platform ids — these are just strings to the
// resolver, no validation against Discord snowflake format.
const LUNA_DISCORD_ID = "1487100000000000001";
const ECHO_DISCORD_ID = "1487100000000000002";
const HOLLY_DISCORD_ID = "1487100000000000003";
const LUNA_MATTERMOST_ID = "luna-mm-userid-abc123";

// =============================================================================
// Construction
// =============================================================================

describe("TrustResolver — construction", () => {
  test("empty resolver has size 0", () => {
    const resolver = new TrustResolver(registryOf(agentFixture({ id: "luna" })));
    expect(resolver.size).toBe(0);
  });

  test("backing registry is exposed via getRegistry()", () => {
    const registry = registryOf(agentFixture({ id: "luna" }));
    const resolver = new TrustResolver(registry);
    expect(resolver.getRegistry()).toBe(registry);
  });
});

// =============================================================================
// register / unregister
// =============================================================================

describe("TrustResolver.register", () => {
  let resolver: TrustResolver;

  beforeEach(() => {
    resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna" }),
      agentFixture({ id: "echo" }),
    ));
  });

  test("registers a new platform identity", () => {
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(resolver.size).toBe(1);
    expect(resolver.lookupAgentId("discord", LUNA_DISCORD_ID)).toBe("luna");
  });

  test("rejects registration for unknown agent id (fail-closed §9.3)", () => {
    expect(() => resolver.register("discord", LUNA_DISCORD_ID, "ghost"))
      .toThrow(AgentNotFoundError);
    expect(resolver.size).toBe(0);
  });

  test("idempotent: re-registering the same agent is a silent no-op", () => {
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(() => resolver.register("discord", LUNA_DISCORD_ID, "luna")).not.toThrow();
    expect(resolver.size).toBe(1);
  });

  test("rejects claiming a registered platform id for a different agent", () => {
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    let err: unknown;
    try {
      resolver.register("discord", LUNA_DISCORD_ID, "echo");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PlatformIdAlreadyRegisteredError);
    expect((err as PlatformIdAlreadyRegisteredError).existingAgentId).toBe("luna");
    expect((err as PlatformIdAlreadyRegisteredError).attemptedAgentId).toBe("echo");
    expect((err as PlatformIdAlreadyRegisteredError).platform).toBe("discord");
    expect((err as PlatformIdAlreadyRegisteredError).platformId).toBe(LUNA_DISCORD_ID);
    // Original mapping is preserved.
    expect(resolver.lookupAgentId("discord", LUNA_DISCORD_ID)).toBe("luna");
  });

  test("same platform id across different platforms is OK", () => {
    // A Discord id and a Mattermost id could collide as strings (unlikely
    // but valid). Treat them as different identities.
    resolver.register("discord", "1487", "luna");
    resolver.register("mattermost", "1487", "echo");
    expect(resolver.lookupAgentId("discord", "1487")).toBe("luna");
    expect(resolver.lookupAgentId("mattermost", "1487")).toBe("echo");
  });

  test("one agent can own multiple platform identities", () => {
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    resolver.register("mattermost", LUNA_MATTERMOST_ID, "luna");
    expect(resolver.size).toBe(2);
    const owned = resolver.identitiesOf("luna");
    expect(owned).toContainEqual({ platform: "discord", platformId: LUNA_DISCORD_ID });
    expect(owned).toContainEqual({ platform: "mattermost", platformId: LUNA_MATTERMOST_ID });
  });
});

describe("TrustResolver.unregister", () => {
  let resolver: TrustResolver;

  beforeEach(() => {
    resolver = new TrustResolver(registryOf(agentFixture({ id: "luna" })));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
  });

  test("removes the forward mapping", () => {
    resolver.unregister("discord", LUNA_DISCORD_ID);
    expect(resolver.lookupAgentId("discord", LUNA_DISCORD_ID)).toBeUndefined();
    expect(resolver.size).toBe(0);
  });

  test("removes the reverse mapping for the affected agent", () => {
    resolver.unregister("discord", LUNA_DISCORD_ID);
    expect(resolver.identitiesOf("luna")).toEqual([]);
  });

  test("unregistering an unknown pair is a silent no-op", () => {
    expect(() => resolver.unregister("discord", "unregistered-id")).not.toThrow();
    expect(resolver.size).toBe(1); // existing luna mapping intact
  });

  test("unregistering one of an agent's multiple identities leaves the others", () => {
    resolver.register("mattermost", LUNA_MATTERMOST_ID, "luna");
    resolver.unregister("discord", LUNA_DISCORD_ID);
    expect(resolver.identitiesOf("luna")).toEqual([
      { platform: "mattermost", platformId: LUNA_MATTERMOST_ID },
    ]);
  });
});

// =============================================================================
// Lookup helpers
// =============================================================================

describe("TrustResolver — lookup", () => {
  let resolver: TrustResolver;

  beforeEach(() => {
    resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna" }),
      agentFixture({ id: "echo" }),
    ));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
  });

  test("lookupAgentId returns the agent id for a registered pair", () => {
    expect(resolver.lookupAgentId("discord", LUNA_DISCORD_ID)).toBe("luna");
  });

  test("lookupAgentId returns undefined for an unregistered pair", () => {
    expect(resolver.lookupAgentId("discord", "unknown-id")).toBeUndefined();
    expect(resolver.lookupAgentId("mattermost", LUNA_DISCORD_ID)).toBeUndefined();
  });

  test("lookupAgent returns the full Agent object", () => {
    const luna = resolver.lookupAgent("discord", LUNA_DISCORD_ID);
    expect(luna?.id).toBe("luna");
    expect(luna?.displayName).toBe("Luna");
  });

  test("lookupAgent returns undefined for an unregistered pair", () => {
    expect(resolver.lookupAgent("discord", "unknown-id")).toBeUndefined();
  });

  test("identitiesOf returns [] for an agent with no registrations", () => {
    expect(resolver.identitiesOf("echo")).toEqual([]);
  });

  test("identitiesOf returns [] for an unknown agent", () => {
    expect(resolver.identitiesOf("ghost")).toEqual([]);
  });

  // cortex#98 (part B) — inverse lookup used by cortex.ts to translate an
  // agent's `trust: [<peer-id>, ...]` list into peer bot user ids for the
  // Discord trustedBotIds allowlist.
  test("lookupPlatformIdByAgent returns the registered Discord id for a known agent", () => {
    expect(resolver.lookupPlatformIdByAgent("discord", "luna")).toBe(LUNA_DISCORD_ID);
  });

  test("lookupPlatformIdByAgent returns undefined when the agent has no registration on that platform", () => {
    // Luna only has a Discord registration; mattermost lookup is undefined.
    expect(resolver.lookupPlatformIdByAgent("mattermost", "luna")).toBeUndefined();
  });

  test("lookupPlatformIdByAgent returns undefined for an agent with no registrations at all (cross-process peer)", () => {
    expect(resolver.lookupPlatformIdByAgent("discord", "echo")).toBeUndefined();
  });

  test("lookupPlatformIdByAgent returns undefined for an unknown agent id", () => {
    expect(resolver.lookupPlatformIdByAgent("discord", "ghost")).toBeUndefined();
  });

  test("lookupPlatformIdByAgent picks the right platform when an agent has multiple", () => {
    resolver.register("mattermost", LUNA_MATTERMOST_ID, "luna");
    expect(resolver.lookupPlatformIdByAgent("discord", "luna")).toBe(LUNA_DISCORD_ID);
    expect(resolver.lookupPlatformIdByAgent("mattermost", "luna")).toBe(LUNA_MATTERMOST_ID);
  });
});

// =============================================================================
// trustsByPlatformId — the load-bearing call from receiving adapters
// =============================================================================

describe("TrustResolver.trustsByPlatformId", () => {
  test("true when receiver's agent trusts the sender's agent", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "echo", trust: ["luna"] }),
      agentFixture({ id: "luna" }),
    ));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(resolver.trustsByPlatformId("echo", "discord", LUNA_DISCORD_ID)).toBe(true);
  });

  test("false when receiver's agent does not trust the sender", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "echo", trust: [] }),
      agentFixture({ id: "luna" }),
    ));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(resolver.trustsByPlatformId("echo", "discord", LUNA_DISCORD_ID)).toBe(false);
  });

  test("false when the sender platform id is unregistered (human message)", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "echo", trust: ["luna"] }),
      agentFixture({ id: "luna" }),
    ));
    // No register call — the sender is a human Discord user, not an agent.
    expect(resolver.trustsByPlatformId("echo", "discord", "human-user-id")).toBe(false);
  });

  test("false when the receiver agent itself is unknown", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna" }),
    ));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(resolver.trustsByPlatformId("ghost-receiver", "discord", LUNA_DISCORD_ID)).toBe(false);
  });

  test("self-trust resolves correctly across the platform-id layer", () => {
    // luna sends to herself via Discord → trustsByPlatformId("luna", ...) is true
    const resolver = new TrustResolver(registryOf(agentFixture({ id: "luna" })));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(resolver.trustsByPlatformId("luna", "discord", LUNA_DISCORD_ID)).toBe(true);
  });

  test("multi-trust: luna trusts both echo and holly via discord", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna", trust: ["echo", "holly"] }),
      agentFixture({ id: "echo" }),
      agentFixture({ id: "holly" }),
    ));
    resolver.register("discord", ECHO_DISCORD_ID, "echo");
    resolver.register("discord", HOLLY_DISCORD_ID, "holly");
    expect(resolver.trustsByPlatformId("luna", "discord", ECHO_DISCORD_ID)).toBe(true);
    expect(resolver.trustsByPlatformId("luna", "discord", HOLLY_DISCORD_ID)).toBe(true);
  });

  test("respects platform isolation: discord trust ≠ mattermost trust", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "echo", trust: ["luna"] }),
      agentFixture({ id: "luna" }),
    ));
    // Register luna only on Discord. Mattermost id for luna is not registered.
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    expect(resolver.trustsByPlatformId("echo", "discord", LUNA_DISCORD_ID)).toBe(true);
    // Same id on mattermost → not registered → false.
    expect(resolver.trustsByPlatformId("echo", "mattermost", LUNA_DISCORD_ID)).toBe(false);
  });
});

// =============================================================================
// Platform key encoding — defensive against id strings containing the separator
// =============================================================================

describe("TrustResolver — platform key encoding", () => {
  test("platform ids containing |  are unambiguously parsed (defence-in-depth)", () => {
    // Discord/Mattermost ids never contain `|`, but if a future platform
    // does, the parseKey logic splits on the FIRST `|` so a `|` in the
    // platformId portion survives.
    const resolver = new TrustResolver(registryOf(agentFixture({ id: "luna" })));
    const weirdId = "abc|def|ghi";
    resolver.register("discord" as Platform, weirdId, "luna");
    expect(resolver.lookupAgentId("discord", weirdId)).toBe("luna");
    const owned = resolver.identitiesOf("luna");
    expect(owned).toEqual([{ platform: "discord", platformId: weirdId }]);
  });
});

// =============================================================================
// cortex#98 (part B) — cortex.ts merge algorithm shape
// =============================================================================
//
// These tests assert the algorithm cortex.ts runs in Pass 2 of its Discord
// adapter loop: for each agent's `trust:[]`, look up each peer's Discord
// bot user id via `lookupPlatformIdByAgent` and merge into the operator-
// explicit `trustedBotIds`. They live next to the resolver tests because
// the algorithm is pure-data over resolver state — wiring into a live
// DiscordAdapter would require a Discord.js mock that adds noise without
// validating the lookup logic itself.

describe("cortex#98 (part B) — auto-populate trustedBotIds from agents[].trust", () => {
  function mergeFor(
    resolver: TrustResolver,
    agentTrust: readonly string[],
    selfAgentId: string,
    explicit: readonly string[],
  ): Set<string> {
    // Mirror of the merge cortex.ts performs at the bottom of the Discord
    // adapter-start loop. Kept in lock-step with the cortex.ts
    // implementation; both contain the same self-skip + undefined-skip
    // semantics.
    const merged = new Set<string>(explicit);
    for (const peerAgentId of agentTrust) {
      if (peerAgentId === selfAgentId) continue;
      const peerBotId = resolver.lookupPlatformIdByAgent("discord", peerAgentId);
      if (peerBotId !== undefined) merged.add(peerBotId);
    }
    return merged;
  }

  test("in-process peers resolve via the resolver and merge into the allowlist", () => {
    // Three-bot in-process deployment: luna trusts [echo, forge]; both
    // have registered their bot ids in the resolver during Pass 1 of
    // adapter-start.
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna", trust: ["echo", "forge"] }),
      agentFixture({ id: "echo" }),
      agentFixture({ id: "forge" }),
    ));
    resolver.register("discord", ECHO_DISCORD_ID, "echo");
    resolver.register("discord", "1497954389736947876", "forge");

    const merged = mergeFor(resolver, ["echo", "forge"], "luna", []);
    expect(merged.size).toBe(2);
    expect(merged.has(ECHO_DISCORD_ID)).toBe(true);
    expect(merged.has("1497954389736947876")).toBe(true);
  });

  test("operator-explicit trustedBotIds (cross-process bridge) merge with resolver-derived ids", () => {
    // luna trusts [echo, holly]; echo is in-process (registered), holly is
    // cross-process (the operator put holly's bot id in
    // presence.discord.trustedBotIds because she lives in a server cortex).
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna", trust: ["echo", "holly"] }),
      agentFixture({ id: "echo" }),
      agentFixture({ id: "holly" }),
    ));
    resolver.register("discord", ECHO_DISCORD_ID, "echo");
    // holly NOT registered — she's cross-process.

    const explicit = [HOLLY_DISCORD_ID];
    const merged = mergeFor(resolver, ["echo", "holly"], "luna", explicit);
    expect(merged.size).toBe(2);
    expect(merged.has(ECHO_DISCORD_ID)).toBe(true); // resolver-derived
    expect(merged.has(HOLLY_DISCORD_ID)).toBe(true); // operator-explicit
  });

  test("cross-process peers (unregistered) are silently skipped — set stays at explicit baseline", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna", trust: ["holly"] }),
      agentFixture({ id: "holly" }),
    ));
    // holly NOT registered — cross-process peer.

    const merged = mergeFor(resolver, ["holly"], "luna", []);
    expect(merged.size).toBe(0); // no auto-pop, no explicit — empty set
  });

  test("self-trust entry is skipped (adapter's self-loop guard handles it independently)", () => {
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna", trust: ["luna", "echo"] }), // luna trusts herself + echo
      agentFixture({ id: "echo" }),
    ));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");
    resolver.register("discord", ECHO_DISCORD_ID, "echo");

    const merged = mergeFor(resolver, ["luna", "echo"], "luna", []);
    expect(merged.size).toBe(1);
    expect(merged.has(LUNA_DISCORD_ID)).toBe(false); // self-skip
    expect(merged.has(ECHO_DISCORD_ID)).toBe(true);
  });

  test("empty trust list → merged equals explicit verbatim (legacy bot.yaml path)", () => {
    const resolver = new TrustResolver(registryOf(agentFixture({ id: "luna", trust: [] })));
    resolver.register("discord", LUNA_DISCORD_ID, "luna");

    const explicit = ["1487999999999999999"]; // op-set cross-process id
    const merged = mergeFor(resolver, [], "luna", explicit);
    expect(merged.size).toBe(1);
    expect(merged.has("1487999999999999999")).toBe(true);
  });

  test("explicit and resolver-derived ids dedupe when they overlap", () => {
    // Edge case: operator hand-set echo's bot id in cortex.yaml AND echo
    // is in-process (registered). The merge naturally dedupes via Set.
    const resolver = new TrustResolver(registryOf(
      agentFixture({ id: "luna", trust: ["echo"] }),
      agentFixture({ id: "echo" }),
    ));
    resolver.register("discord", ECHO_DISCORD_ID, "echo");

    const merged = mergeFor(resolver, ["echo"], "luna", [ECHO_DISCORD_ID]);
    expect(merged.size).toBe(1); // not 2 — dedupe
    expect(merged.has(ECHO_DISCORD_ID)).toBe(true);
  });
});
