/**
 * MIG-7.2a — Agent registry tests.
 *
 * Covers:
 *   - Construction from parsed CortexConfig and from raw Agent[] arrays
 *   - Trust closure validation (forward refs, missing refs, self-trust)
 *   - Strict + soft lookup semantics
 *   - getTrustedPeers — resolves to Agent objects, filters self-trust
 *   - `trusts(a, b)` — explicit + self-trust
 *   - Immutability — the registry surface refuses mutation
 *   - Order preservation — config order matches getAll() order
 */

import { describe, test, expect } from "bun:test";

import {
  AgentNotFoundError,
  AgentRegistry,
  DuplicateAgentIdError,
  UnknownAgentReferenceError,
} from "../registry";
import type { Agent, CortexConfig } from "../../types/cortex-config";

// =============================================================================
// Fixture builders
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
    trust: [],
    presence: { discord: discordPresence() },
    ...overrides,
  } as Agent;
}

function cortexConfigFixture(agents: Agent[]): CortexConfig {
  return {
    principal: {
      id: "andreas",
      dataResidency: "NZ",
    },
    bus: {
      review: {
        stream: {
          name: "CODE_REVIEW",
          maxAgeSeconds: 86_400,
          maxBytes: 512 * 1024 * 1024,
        },
        consumer: { maxDeliver: 5 },
      },
      lifecycle: {
        stream: {
          name: "REVIEW_LIFECYCLE",
          maxAgeSeconds: 86_400,
          maxBytes: 512 * 1024 * 1024,
        },
      },
      devImplement: {
        stream: {
          name: "DEV_IMPLEMENT",
          maxAgeSeconds: 86_400,
          maxBytes: 512 * 1024 * 1024,
        },
      },
    },
    agents,
    renderers: [],
    claude: {
      timeoutMs: 120_000,
      asyncTimeoutMs: 900_000,
      additionalArgs: [],
      allowedTools: [],
      disallowedTools: [],
      allowedDirs: [],
      readOnlyDirs: [],
    },
    attachments: {
      enabled: true,
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxTotalSizeBytes: 25 * 1024 * 1024,
      maxAttachmentsPerMessage: 10,
    },
    execution: { default: "local", backends: [] },
    github: {
      webhookSecret: "",
      repos: [],
      agentDetection: {
        commitTrailers: ["Co-Authored-By: Claude"],
        branchPatterns: ["^feat/(g|f|i)-\\d+"],
        commentPatterns: ["^Starting:", "^Completed:"],
      },
      receiver: {
        enabled: false,
        port: 8770,
        hostname: "127.0.0.1",
      },
    },
    paths: {
      publishedEventsDir: "~/.claude/events/published",
      logDir: "~/.config/cortex/logs",
    },
    networksDir: "./networks",
    networks: [],
    // IAW Phase A.6 (cortex#113) — the `capabilities:` block has a `.default([])`
    // on the schema, but the inferred CortexConfig OUTPUT type lists it as a
    // required field (defaults always present after parse). Fixture literals
    // that `as CortexConfig` cast through this builder therefore need to
    // include it explicitly. Registry tests don't exercise capabilities; an
    // empty array is the right zero-value.
    capabilities: [],
    // TC-0 (#628) — same `.default()`-but-required-on-output story as
    // `capabilities` above: `SecurityPostureSchema` fills defaults after parse,
    // so the inferred OUTPUT type lists `security` as required. Registry tests
    // don't exercise the posture; the all-`off` default is the right zero-value.
    security: {
      signing: "off",
      encryption: { payload: "off", at_rest: "off" },
      transport: { mtls: "off" },
    },
    mc: { enabled: false, configPath: "", dbPath: "", port: 0, sideband: "http://127.0.0.1:9092", server: { enabled: true }, aggregateLocalStacks: { enabled: true, dbRead: true, configRoot: "", stacks: [] } },
    cockpit: {
      enabled: false,
      docsDir: "docs",
      repo: "",
      refreshIntervalMs: 300_000,
      attention: { surface: "discord", channel: "" },
    },
    // fix/c-844 — grove is now on CortexConfigSchema (shared GroveSchema); the
    // transform fills defaults so the inferred OUTPUT type lists it as required.
    grove: { notifications: { discord: false }, baseUrl: "" },
  };
}

// =============================================================================
// Construction
// =============================================================================

describe("AgentRegistry.fromConfig", () => {
  test("zero-agent registries are tolerated at the registry layer", () => {
    // The schema (CortexConfigSchema.agents.min(1)) is the gatekeeper for
    // the architecture §9.1 "≥1 agent" rule. The registry itself does not
    // re-enforce it — passing `[]` directly to `fromAgents` is legal so
    // tests can construct empty registries without setting up a full config.
    const registry = AgentRegistry.fromAgents([]);
    expect(registry.size).toBe(0);
    expect(registry.getAll()).toEqual([]);
  });

  test("builds registry from CortexConfig", () => {
    const config = cortexConfigFixture([
      agentFixture({ id: "luna", displayName: "Luna" }),
      agentFixture({ id: "echo", displayName: "Echo" }),
    ]);
    const registry = AgentRegistry.fromConfig(config);
    expect(registry.size).toBe(2);
    expect(registry.getById("luna").displayName).toBe("Luna");
    expect(registry.getById("echo").displayName).toBe("Echo");
  });

  test("preserves config order in getAll()", () => {
    const config = cortexConfigFixture([
      agentFixture({ id: "luna" }),
      agentFixture({ id: "echo" }),
      agentFixture({ id: "holly" }),
      agentFixture({ id: "ivy" }),
    ]);
    const registry = AgentRegistry.fromConfig(config);
    expect(registry.getAll().map((a) => a.id)).toEqual(["luna", "echo", "holly", "ivy"]);
  });

  test("rejects duplicate agent ids at registry layer (defence-in-depth)", () => {
    expect(() => AgentRegistry.fromAgents([
      agentFixture({ id: "luna" }),
      agentFixture({ id: "luna", displayName: "Luna 2" }),
    ])).toThrow(DuplicateAgentIdError);
  });
});

// =============================================================================
// Trust closure validation
// =============================================================================

describe("AgentRegistry — trust closure", () => {
  test("accepts forward references (luna trusts echo, echo defined later)", () => {
    expect(() => AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: ["echo"] }),
      agentFixture({ id: "echo" }),
    ])).not.toThrow();
  });

  test("throws UnknownAgentReferenceError on missing trust target", () => {
    let thrown: unknown;
    try {
      AgentRegistry.fromAgents([
        agentFixture({ id: "luna", trust: ["ghost"] }),
      ]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownAgentReferenceError);
    expect((thrown as UnknownAgentReferenceError).fromAgent).toBe("luna");
    expect((thrown as UnknownAgentReferenceError).unresolvedId).toBe("ghost");
    expect((thrown as Error).message).toMatch(/trust:\[\] must be a known agent id/);
  });

  test("allows self-trust at construction time", () => {
    expect(() => AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: ["luna"] }),
    ])).not.toThrow();
  });

  test("trust closure is validated across all agents (not just first)", () => {
    expect(() => AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: ["echo"] }),
      agentFixture({ id: "echo", trust: ["holly"] }), // ← holly missing
    ])).toThrow(/echo.*holly/s);
  });
});

// =============================================================================
// Lookup semantics
// =============================================================================

describe("AgentRegistry.getById / tryGetById", () => {
  const registry = AgentRegistry.fromAgents([
    agentFixture({ id: "luna" }),
    agentFixture({ id: "echo" }),
  ]);

  test("getById returns the agent for a known id", () => {
    expect(registry.getById("luna").id).toBe("luna");
  });

  test("getById throws AgentNotFoundError for an unknown id (Holly W1)", () => {
    // Previous revision reused UnknownAgentReferenceError with a
    // `"<caller>"` placeholder fromAgent — misleading because plain lookup
    // has no trust-relationship semantics. AgentNotFoundError is a dedicated
    // class with just the offending id.
    let err: unknown;
    try {
      registry.getById("ghost");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AgentNotFoundError);
    expect(err).not.toBeInstanceOf(UnknownAgentReferenceError);
    expect((err as AgentNotFoundError).id).toBe("ghost");
    expect((err as AgentNotFoundError).name).toBe("AgentNotFoundError");
    expect((err as AgentNotFoundError).message).toBe('no agent registered with id "ghost"');
  });

  test("tryGetById returns the agent for a known id", () => {
    expect(registry.tryGetById("luna")?.id).toBe("luna");
  });

  test("tryGetById returns undefined for an unknown id", () => {
    expect(registry.tryGetById("ghost")).toBeUndefined();
  });
});

// =============================================================================
// getTrustedPeers
// =============================================================================

describe("AgentRegistry.getTrustedPeers", () => {
  test("resolves trust ids to Agent objects in declaration order", () => {
    const registry = AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: ["echo", "holly"] }),
      agentFixture({ id: "echo" }),
      agentFixture({ id: "holly" }),
    ]);
    const peers = registry.getTrustedPeers("luna");
    expect(peers.map((a) => a.id)).toEqual(["echo", "holly"]);
  });

  test("returns empty array for an agent with no trust list", () => {
    const registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    expect(registry.getTrustedPeers("luna")).toEqual([]);
  });

  test("filters out self-trust", () => {
    const registry = AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: ["luna", "echo"] }),
      agentFixture({ id: "echo" }),
    ]);
    expect(registry.getTrustedPeers("luna").map((a) => a.id)).toEqual(["echo"]);
  });

  test("throws AgentNotFoundError if the agent itself is unknown", () => {
    const registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    expect(() => registry.getTrustedPeers("ghost")).toThrow(AgentNotFoundError);
  });
});

// =============================================================================
// trusts(a, b)
// =============================================================================

describe("AgentRegistry.trusts", () => {
  const registry = AgentRegistry.fromAgents([
    agentFixture({ id: "luna", trust: ["echo", "holly"] }),
    agentFixture({ id: "echo", trust: [] }),
    agentFixture({ id: "holly", trust: [] }),
  ]);

  test("returns true for an explicit trust relationship", () => {
    expect(registry.trusts("luna", "echo")).toBe(true);
    expect(registry.trusts("luna", "holly")).toBe(true);
  });

  test("returns false when truster does not trust trusted", () => {
    expect(registry.trusts("echo", "luna")).toBe(false);
    expect(registry.trusts("echo", "holly")).toBe(false);
  });

  test("returns true for self-trust (each agent trusts itself)", () => {
    expect(registry.trusts("luna", "luna")).toBe(true);
    expect(registry.trusts("echo", "echo")).toBe(true);
  });

  test("returns false when truster is unknown", () => {
    expect(registry.trusts("ghost", "luna")).toBe(false);
  });

  test("returns false when trusted is unknown but truster is known", () => {
    // Trust closure validation at fromConfig prevents this state normally,
    // but the method handles it defensively.
    expect(registry.trusts("luna", "ghost")).toBe(false);
  });
});

// =============================================================================
// Immutability
// =============================================================================

describe("AgentRegistry — immutability", () => {
  test("getAll() result is frozen", () => {
    const registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    const all = registry.getAll();
    expect(Object.isFrozen(all)).toBe(true);
  });

  test("registry survives external mutation of source array", () => {
    const sourceAgents = [
      agentFixture({ id: "luna" }),
      agentFixture({ id: "echo" }),
    ];
    const registry = AgentRegistry.fromAgents(sourceAgents);
    // Mutate the source array externally — the registry must not reflect it.
    sourceAgents.push(agentFixture({ id: "holly" }));
    expect(registry.size).toBe(2);
    expect(registry.tryGetById("holly")).toBeUndefined();
  });

  test("agent objects returned by getById are deep-frozen (Holly W2)", () => {
    // Previous revision shallow-froze the array but not the agents
    // themselves — a downstream `registry.getById("luna").trust.push("x")`
    // would silently bypass the trust closure invariant. Deep-freeze
    // closes the gap.
    const registry = AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: [] }),
    ]);
    const luna = registry.getById("luna");
    expect(Object.isFrozen(luna)).toBe(true);
    expect(Object.isFrozen(luna.trust)).toBe(true);
    // v2.0.0 (cortex#297) — `agent.roles` retired; no array to freeze.
    expect(Object.isFrozen(luna.presence)).toBe(true);
    if (luna.presence.discord) {
      expect(Object.isFrozen(luna.presence.discord)).toBe(true);
    }
  });

  test("attempted mutation of an agent's trust array fails in strict mode", () => {
    // Bun's test runner runs ESM modules in strict mode by default, so
    // pushing onto a frozen array throws. This is the load-bearing
    // assertion for the deep-freeze guarantee.
    const registry = AgentRegistry.fromAgents([
      agentFixture({ id: "luna", trust: [] }),
    ]);
    const luna = registry.getById("luna");
    expect(() => {
      luna.trust.push("evil");
    }).toThrow();
  });

  test("attempted mutation of an agent's presence block fails in strict mode", () => {
    const registry = AgentRegistry.fromAgents([
      agentFixture({ id: "luna" }),
    ]);
    const luna = registry.getById("luna");
    expect(() => {
      (luna.presence as { discord?: unknown }).discord = undefined;
    }).toThrow();
  });

  test("deep-freezing an already-frozen agent is a no-op (idempotent)", () => {
    // Tests sometimes pass already-frozen Agents back through fromAgents
    // (e.g. when building a registry from another registry's getAll()).
    // Re-freezing must not throw.
    const base = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    expect(() => AgentRegistry.fromAgents(base.getAll())).not.toThrow();
  });
});

// =============================================================================
// Error class identity
// =============================================================================

describe("AgentRegistry — error classes", () => {
  test("UnknownAgentReferenceError carries fromAgent + unresolvedId fields", () => {
    let err: unknown;
    try {
      AgentRegistry.fromAgents([agentFixture({ id: "luna", trust: ["ghost"] })]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownAgentReferenceError);
    expect(err).toBeInstanceOf(Error);
    expect((err as UnknownAgentReferenceError).name).toBe("UnknownAgentReferenceError");
    expect((err as UnknownAgentReferenceError).fromAgent).toBe("luna");
    expect((err as UnknownAgentReferenceError).unresolvedId).toBe("ghost");
  });

  test("DuplicateAgentIdError carries the duplicated id", () => {
    let err: unknown;
    try {
      AgentRegistry.fromAgents([
        agentFixture({ id: "luna" }),
        agentFixture({ id: "luna" }),
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicateAgentIdError);
    expect((err as DuplicateAgentIdError).id).toBe("luna");
  });
});
