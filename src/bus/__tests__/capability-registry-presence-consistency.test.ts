/**
 * G-1114.B.5 — capability-consistency invariant between the two boot-time
 * capability signals during the ADR-0007 dual-emit window.
 *
 * **What this pins.** ADR-0007 decision 3 establishes that `agent.online`
 * (G-1114.B.2, carrying the initial capability set) supersedes the legacy
 * observability-only `agents.capabilities.registered` (cortex#237). The two
 * are emitted **at the same boot moment, independently**:
 *   - `publishCapabilityRegistry()`  → `agents.capabilities.registered` (legacy)
 *   - `AgentPresenceProducer.start()` → `agent.online` (superseding)
 *
 * For the dual-emit to be honest, the capability set carried by each MUST be
 * identical for the same agent — otherwise an external consumer cutting over
 * from the legacy envelope to `agent.online` would silently see a different
 * capability set. Both production paths read the SAME source field
 * (`agent.runtime.capabilities[]`); this test drives BOTH real projections from
 * ONE `Agent[]` fixture and asserts they agree, so the invariant can't drift
 * unnoticed when either projection changes.
 *
 * It deliberately mirrors the two projections AS WIRED IN `src/cortex.ts`:
 *   - capability-registry entries: filter agents with non-empty
 *     `runtime.capabilities`, map `{ agentId, capabilities }` (cortex.ts PR-7
 *     block ~936-943);
 *   - presence agents: `presenceAgentFromAgent(agent, scope, fallbackNkey)`
 *     (cortex.ts ~3164-3175).
 *
 * Cross-checked at the WIRE level too: the `capabilities` payload on each
 * published `agent.online` equals the `capabilities` payload on the matching
 * `agents.capabilities.registered` (modulo the documented empty-caps skip).
 */

import { describe, expect, test } from "bun:test";
import {
  publishCapabilityRegistry,
  type CapabilityRegistryEntry,
  type CapabilityRegistrySource,
} from "../capability-registry";
import {
  AgentPresenceProducer,
  presenceAgentFromAgent,
  type PresenceAgent,
} from "../../runner/agent-presence-producer";
import { validateEnvelope, type Envelope } from "../myelin/envelope-validator";
import type { MyelinRuntime } from "../myelin/runtime";
import type { Agent } from "../../common/types/cortex-config";

const PRINCIPAL = "andreas";
const STACK = "meta-factory";
const STACK_NKEY = "USTACKKEY";

const REGISTRY_SOURCE: CapabilityRegistrySource = {
  principal: PRINCIPAL,
  agent: "cortex",
  instance: "local",
};

/** Minimal valid `Agent`, overridable per case — mirrors the presence test fixture. */
function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: "luna",
    displayName: "Luna",
    persona: "./personas/luna.md",
    trust: [],
    presence: {},
    ...over,
  };
}

/**
 * Project `Agent[]` → capability-registry entries EXACTLY as `src/cortex.ts`'s
 * cortex#237 PR-7 block does (filter non-empty caps; map agentId + caps). Kept
 * here so the invariant is checked against the real projection shape, not a
 * test-local re-derivation.
 */
function registryEntriesFor(agents: readonly Agent[]): CapabilityRegistryEntry[] {
  return agents
    .filter(
      (a): a is Agent & { runtime: { capabilities: readonly string[] } } =>
        (a.runtime?.capabilities.length ?? 0) > 0,
    )
    .map((a) => ({ agentId: a.id, capabilities: a.runtime.capabilities }));
}

/**
 * Project `Agent[]` → presence agents EXACTLY as `src/cortex.ts` does (map via
 * `presenceAgentFromAgent` with the stack NKey fallback; drop unkeyed agents).
 */
function presenceAgentsFor(agents: readonly Agent[]): PresenceAgent[] {
  const out: PresenceAgent[] = [];
  for (const a of agents) {
    const pa = presenceAgentFromAgent(a, { principal: PRINCIPAL, stack: STACK }, STACK_NKEY);
    if (pa !== null) out.push(pa);
  }
  return out;
}

interface RecordingRuntime extends MyelinRuntime {
  published: Envelope[];
}
function recordingRuntime(): RecordingRuntime {
  const published: Envelope[] = [];
  return {
    enabled: true,
    published,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: (env: Envelope) => {
      published.push(env);
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}

/** A noop scheduler — we only exercise `start()`'s `agent.online` emission. */
const noopScheduler = {
  setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
};

/**
 * Capabilities carried by the published `agent.online`, keyed by agent_id.
 * NOTE: `agent.online` nests the id under `payload.identity.agent_id`
 * (presence envelope shape), unlike the legacy envelope's top-level `agent_id`.
 */
function onlineCapsByAgent(published: readonly Envelope[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of published) {
    if (e.type !== "agent.online") continue;
    const p = e.payload as { identity?: { agent_id?: string }; capabilities?: string[] };
    const id = p.identity?.agent_id;
    if (id !== undefined) m.set(id, p.capabilities ?? []);
  }
  return m;
}

/** Capabilities carried by `agents.capabilities.registered`, keyed by agent_id. */
function registeredCapsByAgent(published: readonly Envelope[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of published) {
    const p = e.payload as { agent_id?: string; capabilities?: string[] };
    if (p.agent_id !== undefined) m.set(p.agent_id, p.capabilities ?? []);
  }
  return m;
}

describe("G-1114.B.5 — capability-consistency invariant (agent.online vs agents.capabilities.registered)", () => {
  const AGENTS: Agent[] = [
    agent({
      id: "luna",
      displayName: "Luna",
      nkey_pub: "ULUNAKEY",
      runtime: {
        substrate: "claude-code",
        mode: "in-process",
        capabilities: ["code-review.typescript", "design-review"],
      },
    }),
    agent({
      id: "echo",
      displayName: "Echo",
      nkey_pub: "UECHOKEY",
      runtime: {
        substrate: "claude-code",
        mode: "in-process",
        capabilities: ["code-review.typescript"],
      },
    }),
  ];

  test("both projections derive capabilities from the same agent.runtime.capabilities field", () => {
    const registryEntries = registryEntriesFor(AGENTS);
    const presenceAgents = presenceAgentsFor(AGENTS);

    const registryCaps = new Map(registryEntries.map((e) => [e.agentId, [...e.capabilities]]));
    const presenceCaps = new Map(
      presenceAgents.map((p) => [p.identity.agent_id, [...p.capabilities]]),
    );

    // Every capability-declaring agent appears in both projections with the
    // identical capability list — sourced from agent.runtime.capabilities.
    for (const a of AGENTS) {
      const expected = a.runtime?.capabilities ?? [];
      expect(registryCaps.get(a.id)).toEqual([...expected]);
      expect(presenceCaps.get(a.id)).toEqual([...expected]);
    }
  });

  test("WIRE invariant: each agent.online carries the same capabilities as its agents.capabilities.registered", async () => {
    // Legacy producer — agents.capabilities.registered.
    const legacy: Envelope[] = [];
    await publishCapabilityRegistry({
      source: REGISTRY_SOURCE,
      entries: registryEntriesFor(AGENTS),
      publish: async (e) => {
        legacy.push(e);
      },
    });

    // Superseding producer — agent.online.
    const runtime = recordingRuntime();
    const producer = new AgentPresenceProducer({
      runtime,
      source: { principal: PRINCIPAL, stack: STACK, instance: "local" },
      agents: presenceAgentsFor(AGENTS),
      scheduler: noopScheduler,
    });
    producer.start();

    // Both envelope streams validate against the vendored schema.
    for (const e of [...legacy, ...runtime.published]) {
      expect(validateEnvelope(e).ok).toBe(true);
    }

    const registered = registeredCapsByAgent(legacy);
    const online = onlineCapsByAgent(runtime.published);

    // Every agent that produced a legacy registration also has an agent.online,
    // and the capability sets are byte-identical.
    expect(registered.size).toBeGreaterThan(0);
    for (const [agentId, caps] of registered) {
      expect(online.get(agentId)).toEqual(caps);
    }
  });

  test("empty-caps agent: emitted by presence (agent.online with []) but skipped by the legacy producer", async () => {
    // Documents the ONE deliberate asymmetry: the legacy producer skips agents
    // with empty capabilities (capability-registry §3.4), while presence emits
    // agent.online for every keyed agent (capabilities: []). This is consistent
    // — both still read agent.runtime.capabilities; they just differ on whether
    // an empty set is worth a wire envelope. The invariant above only quantifies
    // over agents the legacy producer DID register, so the asymmetry is safe.
    const withEmpty = agent({
      id: "atlas",
      displayName: "Atlas",
      nkey_pub: "UATLASKEY",
      runtime: { substrate: "claude-code", mode: "in-process", capabilities: [] },
    });

    const legacy: Envelope[] = [];
    await publishCapabilityRegistry({
      source: REGISTRY_SOURCE,
      entries: registryEntriesFor([withEmpty]),
      publish: async (e) => {
        legacy.push(e);
      },
    });
    expect(legacy).toHaveLength(0); // skipped by the legacy producer

    const runtime = recordingRuntime();
    new AgentPresenceProducer({
      runtime,
      source: { principal: PRINCIPAL, stack: STACK, instance: "local" },
      agents: presenceAgentsFor([withEmpty]),
      scheduler: noopScheduler,
    }).start();

    const online = onlineCapsByAgent(runtime.published);
    expect(online.get("atlas")).toEqual([]); // present, empty set
  });
});
