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

function cortexConfigFixture(agents: Agent[]): CortexConfig {
  return {
    operator: {
      id: "andreas",
      dataResidency: "NZ",
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
    },
    paths: {
      publishedEventsDir: "~/.claude/events/published",
      logDir: "~/.config/cortex/logs",
    },
    networksDir: "./networks",
    networks: [],
  } as CortexConfig;
}

// =============================================================================
// Construction
// =============================================================================

describe("AgentRegistry.fromConfig", () => {
  test("builds an empty registry path is illegal — CortexConfig requires ≥1 agent (schema layer)", () => {
    // Defensive: even bypassing the schema, the registry handles zero agents
    // by simply having size === 0. The schema is the gatekeeper for the
    // "≥1 agent" rule (architecture §9.1). The registry doesn't re-enforce it.
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

  test("getById throws for an unknown id", () => {
    expect(() => registry.getById("ghost")).toThrow(UnknownAgentReferenceError);
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

  test("throws if the agent itself is unknown", () => {
    const registry = AgentRegistry.fromAgents([agentFixture({ id: "luna" })]);
    expect(() => registry.getTrustedPeers("ghost")).toThrow(UnknownAgentReferenceError);
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
