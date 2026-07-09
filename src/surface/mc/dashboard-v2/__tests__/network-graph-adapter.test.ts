/**
 * G-1114.D.2 — graph data adapter tests.
 *
 * Asserts the pure projection from the agents snapshot into React-Flow
 * nodes/edges: empty → empty graph; non-empty → one stack-hub + one node/edge
 * per agent; the node data carries presence + lifecycle only (ADR-0007); order
 * is preserved; offline + TTL-lapse agents project their reason.
 */

import { describe, it, expect } from "bun:test";
import {
  buildNetworkGraph,
  collectLegendStacks,
  deriveServingPrincipal,
  federatedPeerIdForPrincipal,
  STACK_HUB_NODE_ID,
  FOREIGN_HUB_ID_PREFIX,
  FEDERATED_PEER_ID_PREFIX,
  type AgentNodeData,
  type StackHubNodeData,
  type FederatedPeerNodeData,
} from "../lib/network-graph-adapter";
import { classifyOrigin } from "../lib/agents-display";
import { LOCAL_STACK_COLOR } from "../lib/stack-color";
import type { AgentPresenceTile } from "../hooks/use-agents";
import type { NetworkMembershipDTO } from "../hooks/use-networks";

function tile(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
    origin: "local",
    assistant_name: null,
    nkey_public_key: `N${agent_id.toUpperCase()}`,
    principal: "andreas",
    stack: "research",
    capabilities: [],
    state: "online",
    offline_reason: null,
    started_at: null,
    last_heartbeat_at: null,
    last_seen_at: 1000,
    ...over,
  };
}

/** A FOREIGN (federated peer) tile — keyed + scoped under the peer's verified id. */
function foreignTile(
  over: Partial<AgentPresenceTile> & {
    agent_id: string;
    principal: string;
    stack: string;
  },
): AgentPresenceTile {
  const { agent_id, principal, stack } = over;
  return tile({
    ...over,
    key: `${principal}/${stack}/${agent_id}`,
    principal,
    stack,
    origin: { principal, stack },
  });
}

/**
 * #1008 — a SAME-PRINCIPAL local SIBLING tile (DB-read aggregation): an OBJECT
 * origin whose principal is the SERVING principal (`andreas`), a DIFFERENT stack.
 * Structurally identical on the wire to a foreign peer — the classifier tells
 * them apart by the serving principal.
 */
function siblingTile(
  over: Partial<AgentPresenceTile> & { agent_id: string; stack: string },
): AgentPresenceTile {
  const { agent_id, stack } = over;
  return tile({
    ...over,
    key: `andreas/${stack}/${agent_id}`,
    principal: "andreas",
    stack,
    origin: { principal: "andreas", stack },
  });
}

describe("buildNetworkGraph (G-1114.D.2)", () => {
  it("returns an empty graph for an empty snapshot", () => {
    const g = buildNetworkGraph([]);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it("synthesises a single stack-hub node for a non-empty snapshot", () => {
    const g = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const hub = g.nodes.find((n) => n.id === STACK_HUB_NODE_ID);
    expect(hub).toBeDefined();
    expect(hub!.type).toBe("stackHub");
    const data = hub!.data as StackHubNodeData;
    expect(data.kind).toBe("stack-hub");
    expect(data.origin).toBe("local");
    expect(data.principal).toBe("andreas");
    expect(data.stack).toBe("research");
    expect(data.agentCount).toBe(1);
    // #1068 — the local hub carries the reserved signature color, and its edge
    // strokes in the same hue.
    expect(data.stackColor).toBe(LOCAL_STACK_COLOR);
    expect(g.edges[0]!.data?.stackColor).toBe(LOCAL_STACK_COLOR);
  });

  it("emits one agent node + one hub→agent edge per agent", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
      tile({ agent_id: "sage" }),
    ]);
    // 3 agents + 1 hub
    expect(g.nodes).toHaveLength(4);
    const agentNodes = g.nodes.filter((n) => n.type === "agent");
    expect(agentNodes).toHaveLength(3);
    // one edge per agent, all sourced from the hub
    expect(g.edges).toHaveLength(3);
    for (const e of g.edges) expect(e.source).toBe(STACK_HUB_NODE_ID);
    const targets = g.edges.map((e) => e.target).sort();
    expect(targets).toEqual(
      [
        "andreas/research/echo",
        "andreas/research/luna",
        "andreas/research/sage",
      ].sort(),
    );
  });

  it("preserves snapshot order for agent nodes (deterministic layout input)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "b" }),
      tile({ agent_id: "a" }),
      tile({ agent_id: "c" }),
    ]);
    const ids = g.nodes
      .filter((n) => n.type === "agent")
      .map((n) => (n.data as AgentNodeData).agentId);
    expect(ids).toEqual(["b", "a", "c"]);
  });

  it("projects presence + lifecycle metadata onto agent node data (ADR-0007)", () => {
    const beat = Date.now();
    const g = buildNetworkGraph([
      tile({
        agent_id: "luna",
        assistant_name: "Luna",
        capabilities: ["review.code", "review.design"],
        state: "online",
        last_heartbeat_at: beat,
      }),
    ]);
    const node = g.nodes.find((n) => n.type === "agent")!;
    const d = node.data as AgentNodeData;
    expect(d.kind).toBe("agent");
    expect(d.key).toBe("andreas/research/luna");
    expect(d.agentId).toBe("luna");
    expect(d.assistantName).toBe("Luna");
    expect(d.capabilities).toEqual(["review.code", "review.design"]);
    expect(d.state).toBe("online");
    expect(d.offlineReason).toBeNull();
    expect(d.lastHeartbeatAt).toBe(beat);
    // No session-interior fields leak onto the node (ADR-0007). The data shape
    // is a fixed allowlist — assert the key set is exactly the presence fields
    // (+ #1068 `stackColor`, a deterministic presentation field derived from the
    // origin, NOT a session interior).
    expect(Object.keys(d).sort()).toEqual(
      [
        "agentId",
        "assistantName",
        "capabilities",
        "key",
        "kind",
        "lastHeartbeatAt",
        "offlineReason",
        "origin",
        "servingPrincipal",
        "stackColor",
        "state",
      ].sort(),
    );
    // #1068 — the agent carries its stack's deterministic color (a member of the
    // palette), shared with its hub. Local agent → the reserved signature hue.
    expect(d.stackColor).toBe(LOCAL_STACK_COLOR);
    // The local agent carries the bare "local" origin.
    expect(d.origin).toBe("local");
  });

  it("carries the offline reason for a TTL-lapsed agent", () => {
    const g = buildNetworkGraph([
      tile({
        agent_id: "sage",
        state: "offline",
        offline_reason: "ttl_lapse",
        last_heartbeat_at: 500,
      }),
    ]);
    const d = g.nodes.find((n) => n.type === "agent")!.data as AgentNodeData;
    expect(d.state).toBe("offline");
    expect(d.offlineReason).toBe("ttl_lapse");
  });

  it("carries a graceful-shutdown offline reason distinctly", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "echo", state: "offline", offline_reason: "shutdown" }),
    ]);
    const d = g.nodes.find((n) => n.type === "agent")!.data as AgentNodeData;
    expect(d.offlineReason).toBe("shutdown");
  });

  it("uses an agent-key-collision-proof reserved id for the hub", () => {
    // An agent whose key somehow equals the hub sentinel must not be mistaken
    // for the hub — keys are `{principal}/{stack}/{id}`, never `__stack__`, so
    // the reserved id is structurally safe. Assert the hub id is the constant.
    const g = buildNetworkGraph([tile({ agent_id: "luna" })]);
    expect(g.nodes[0]!.id).toBe(STACK_HUB_NODE_ID);
    expect(STACK_HUB_NODE_ID).toBe("__stack__");
  });
});

describe("buildNetworkGraph — federated multi-hub grouping (G-1114.E.3)", () => {
  it("lays out a LOCAL-only snapshot byte-identically to Phase D (one hub)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const hubs = g.nodes.filter((n) => n.type === "stackHub");
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.id).toBe(STACK_HUB_NODE_ID);
    expect((hubs[0]!.data as StackHubNodeData).origin).toBe("local");
    // every edge sourced from the single local hub
    for (const e of g.edges) expect(e.source).toBe(STACK_HUB_NODE_ID);
  });

  it("synthesises one hub per distinct foreign {principal}/{stack}, plus the local hub", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      foreignTile({ agent_id: "atlas", principal: "jc", stack: "research" }),
      foreignTile({ agent_id: "nova", principal: "kim", stack: "ops" }),
    ]);
    const hubs = g.nodes.filter((n) => n.type === "stackHub");
    // local + jc/research + kim/ops = 3 hubs
    expect(hubs).toHaveLength(3);
    const hubIds = hubs.map((h) => h.id);
    expect(hubIds).toContain(STACK_HUB_NODE_ID);
    expect(hubIds).toContain(`${FOREIGN_HUB_ID_PREFIX}jc/research`);
    expect(hubIds).toContain(`${FOREIGN_HUB_ID_PREFIX}kim/ops`);
  });

  it("clusters each agent under ITS OWN stack's hub (origin-grouped edges)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      foreignTile({ agent_id: "nova", principal: "kim", stack: "ops" }),
    ]);
    const edgeFor = (key: string) => g.edges.find((e) => e.target === key)!;
    expect(edgeFor("andreas/research/luna").source).toBe(STACK_HUB_NODE_ID);
    expect(edgeFor("jc/research/sage").source).toBe(
      `${FOREIGN_HUB_ID_PREFIX}jc/research`,
    );
    expect(edgeFor("kim/ops/nova").source).toBe(
      `${FOREIGN_HUB_ID_PREFIX}kim/ops`,
    );
  });

  it("tags each foreign hub with its peer provenance + agent count", () => {
    const g = buildNetworkGraph([
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      foreignTile({ agent_id: "atlas", principal: "jc", stack: "research" }),
    ]);
    const hub = g.nodes.find(
      (n) => n.id === `${FOREIGN_HUB_ID_PREFIX}jc/research`,
    )!;
    const d = hub.data as StackHubNodeData;
    expect(d.origin).toEqual({ principal: "jc", stack: "research" });
    expect(d.principal).toBe("jc");
    expect(d.stack).toBe("research");
    expect(d.agentCount).toBe(2);
  });

  it("carries the foreign provenance onto each foreign agent's node data", () => {
    const g = buildNetworkGraph([
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const d = g.nodes.find((n) => n.type === "agent")!.data as AgentNodeData;
    expect(d.origin).toEqual({ principal: "jc", stack: "research" });
  });

  it("emits the LOCAL hub first even when a foreign agent leads the snapshot", () => {
    const g = buildNetworkGraph([
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      tile({ agent_id: "luna" }),
    ]);
    const firstHub = g.nodes.find((n) => n.type === "stackHub")!;
    expect(firstHub.id).toBe(STACK_HUB_NODE_ID);
  });

  it("handles a foreign-ONLY snapshot (no local hub) without error", () => {
    const g = buildNetworkGraph([
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const hubs = g.nodes.filter((n) => n.type === "stackHub");
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.id).toBe(`${FOREIGN_HUB_ID_PREFIX}jc/research`);
  });

  it("returns an empty graph for an empty snapshot (federated path too)", () => {
    expect(buildNetworkGraph([])).toEqual({ nodes: [], edges: [] });
  });
});

describe("deriveServingPrincipal (#1008)", () => {
  it("reads the serving principal off the first local-origin agent", () => {
    expect(
      deriveServingPrincipal([
        tile({ agent_id: "luna" }),
        foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      ]),
    ).toBe("andreas");
  });

  it("returns null when no local agent is present (foreign-only snapshot)", () => {
    expect(
      deriveServingPrincipal([
        foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      ]),
    ).toBeNull();
  });

  it("returns null for an empty snapshot", () => {
    expect(deriveServingPrincipal([])).toBeNull();
  });
});

describe("buildNetworkGraph — local-sibling vs federated classification (#1008)", () => {
  it("threads the serving principal onto every node", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      siblingTile({ agent_id: "echo", stack: "work" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    for (const n of g.nodes) {
      const d = n.data as StackHubNodeData | AgentNodeData;
      expect(d.servingPrincipal).toBe("andreas");
    }
  });

  it("classifies a SAME-PRINCIPAL sibling as local (NOT federated), foreign as federated", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }), // self
      siblingTile({ agent_id: "echo", stack: "work" }), // same-principal sibling
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }), // cross-principal
    ]);

    const selfHub = g.nodes.find((n) => n.id === STACK_HUB_NODE_ID)!
      .data as StackHubNodeData;
    const siblingHub = g.nodes.find(
      (n) => n.id === `${FOREIGN_HUB_ID_PREFIX}andreas/work`,
    )!.data as StackHubNodeData;
    const foreignHub = g.nodes.find(
      (n) => n.id === `${FOREIGN_HUB_ID_PREFIX}jc/research`,
    )!.data as StackHubNodeData;

    // Self + sibling are LOCAL categories; only the cross-principal peer is foreign.
    expect(classifyOrigin(selfHub.origin, selfHub.servingPrincipal)).toBe("self");
    expect(classifyOrigin(siblingHub.origin, siblingHub.servingPrincipal)).toBe(
      "sibling",
    );
    expect(classifyOrigin(foreignHub.origin, foreignHub.servingPrincipal)).toBe(
      "foreign",
    );

    // #1068 — each stack gets a DISTINCT color: self → signature, the two peers
    // → their own (different) hues, and each hub's agents + edge share the hub's.
    expect(selfHub.stackColor).toBe(LOCAL_STACK_COLOR);
    const hubColors = [selfHub, siblingHub, foreignHub].map((h) => h.stackColor);
    expect(new Set(hubColors).size).toBe(3);
    // The sibling agent + its edge carry the SIBLING hub's color, not the local's.
    const siblingAgent = g.nodes.find((n) => n.id === "andreas/work/echo")!
      .data as AgentNodeData;
    expect(siblingAgent.stackColor).toBe(siblingHub.stackColor);
    const siblingEdge = g.edges.find((e) => e.target === "andreas/work/echo")!;
    expect(siblingEdge.data?.stackColor).toBe(siblingHub.stackColor);
  });

  it("still gives each distinct stack its OWN hub (sibling gets its own, not the local one)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      siblingTile({ agent_id: "echo", stack: "work" }),
    ]);
    const hubs = g.nodes.filter((n) => n.type === "stackHub");
    // local hub + the sibling's own hub = 2 distinct hubs
    expect(hubs).toHaveLength(2);
    expect(hubs.map((h) => h.id)).toContain(STACK_HUB_NODE_ID);
    expect(hubs.map((h) => h.id)).toContain(
      `${FOREIGN_HUB_ID_PREFIX}andreas/work`,
    );
    // the sibling agent is wired to its OWN hub, not the local one
    const edge = g.edges.find((e) => e.target === "andreas/work/echo")!;
    expect(edge.source).toBe(`${FOREIGN_HUB_ID_PREFIX}andreas/work`);
  });

  it("classifies an object origin as foreign when the serving principal is unknown", () => {
    // Foreign-only snapshot → no local agent → servingPrincipal null → an object
    // origin can't be proven a sibling, so it conservatively reads foreign.
    const g = buildNetworkGraph([
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const hub = g.nodes.find((n) => n.type === "stackHub")!
      .data as StackHubNodeData;
    expect(hub.servingPrincipal).toBeNull();
    expect(classifyOrigin(hub.origin, hub.servingPrincipal)).toBe("foreign");
  });

  it("a local-only snapshot only gains the servingPrincipal field (otherwise unchanged)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    // one local hub, every node carries servingPrincipal "andreas", origin "local"
    const hubs = g.nodes.filter((n) => n.type === "stackHub");
    expect(hubs).toHaveLength(1);
    for (const n of g.nodes) {
      const d = n.data as StackHubNodeData | AgentNodeData;
      expect(d.origin).toBe("local");
      expect(d.servingPrincipal).toBe("andreas");
    }
  });
});

describe("buildNetworkGraph — agent node ids namespaced by stack (#1065)", () => {
  // #1065: browser-QA of the multi-stack graph (#1060) saw 16 React
  // `Encountered two children with the same key` errors for `andreas`/`luna` —
  // multiple stacks now host an agent with the SAME logical id, so a bare
  // `agent_id` node id collides across the per-stack hubs. React Flow keys its
  // internal node list by `node.id`, so the node id MUST be globally unique.
  // These tests pin the invariant: the node id is the full registry key
  // (`{principal}/{stack}/{agent_id}`), so same-id-different-stack agents get
  // DISTINCT node ids (zero duplicate-key collisions), and the edges + the
  // click→detail selection key + the hover/highlight key all line up on that
  // SAME id so the graph still wires + highlights + selects correctly.

  it("gives two agents that share an agent_id on DIFFERENT stacks DISTINCT node ids", () => {
    // `luna` on andreas/meta-factory AND andreas/work — the real collision the
    // pane-of-glass aggregation surfaced. Bare-id node ids would collide on
    // `luna`; namespaced ids do not.
    const g = buildNetworkGraph([
      tile({ agent_id: "luna", stack: "meta-factory", key: "andreas/meta-factory/luna" }),
      siblingTile({ agent_id: "luna", stack: "work" }),
    ]);
    const agentNodes = g.nodes.filter((n) => n.type === "agent");
    expect(agentNodes).toHaveLength(2);

    const ids = agentNodes.map((n) => n.id);
    expect(ids).toContain("andreas/meta-factory/luna");
    expect(ids).toContain("andreas/work/luna");
    // The load-bearing assertion: no duplicate node ids → no duplicate React keys.
    expect(new Set(ids).size).toBe(ids.length);
    // And specifically NOT the bare logical id that collided in QA.
    expect(ids).not.toContain("luna");
  });

  it("keeps EVERY node id globally unique across local + sibling + foreign hubs sharing agent_ids", () => {
    // The worst case the QA hit: `andreas` and `luna` each present on several
    // stacks at once. Every node id (hubs + agents) must be unique.
    const g = buildNetworkGraph([
      tile({ agent_id: "luna", stack: "meta-factory", key: "andreas/meta-factory/luna" }),
      tile({ agent_id: "andreas", stack: "meta-factory", key: "andreas/meta-factory/andreas" }),
      siblingTile({ agent_id: "luna", stack: "work" }),
      siblingTile({ agent_id: "andreas", stack: "work" }),
      foreignTile({ agent_id: "luna", principal: "jc", stack: "research" }),
      foreignTile({ agent_id: "andreas", principal: "jc", stack: "research" }),
    ]);
    const allIds = g.nodes.map((n) => n.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    // The six agents resolve to six distinct namespaced ids.
    const agentIds = g.nodes.filter((n) => n.type === "agent").map((n) => n.id);
    expect(new Set(agentIds)).toEqual(
      new Set([
        "andreas/meta-factory/luna",
        "andreas/meta-factory/andreas",
        "andreas/work/luna",
        "andreas/work/andreas",
        "jc/research/luna",
        "jc/research/andreas",
      ]),
    );
  });

  it("targets each hub→agent edge at the SAME namespaced node id (edges still connect)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna", stack: "meta-factory", key: "andreas/meta-factory/luna" }),
      siblingTile({ agent_id: "luna", stack: "work" }),
    ]);
    const nodeIds = new Set(g.nodes.map((n) => n.id));
    // Every edge's source + target must reference a node that actually exists —
    // a stale bare-id target would orphan the edge (no line drawn).
    for (const e of g.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
    // The two `luna` edges point at the two DISTINCT namespaced agent nodes.
    const targets = g.edges.map((e) => e.target).sort();
    expect(targets).toEqual(
      ["andreas/meta-factory/luna", "andreas/work/luna"].sort(),
    );
  });

  it("uses the registry key as the node id so click→detail selection + hover/highlight align", () => {
    // The detail panel resolves a clicked node via `agents.find(a => a.key === id)`
    // and the hover/highlight match index keys on `a.key` — both the namespaced
    // registry key. The node id MUST equal `data.key` so a click/hover on a node
    // resolves the right agent (and the right ONE of two same-id siblings).
    const g = buildNetworkGraph([
      tile({ agent_id: "luna", stack: "meta-factory", key: "andreas/meta-factory/luna" }),
      siblingTile({ agent_id: "luna", stack: "work" }),
    ]);
    for (const n of g.nodes.filter((n) => n.type === "agent")) {
      const d = n.data as AgentNodeData;
      // node.id (the React key + the lifted selection key) === data.key (the
      // hover/match key + the detail-panel lookup key). One id, three consumers.
      expect(n.id).toBe(d.key);
    }
  });

  it("still produces a stable single-stack id (regression: no namespacing change for the common case)", () => {
    const g = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const agentNode = g.nodes.find((n) => n.type === "agent")!;
    expect(agentNode.id).toBe("andreas/research/luna");
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.target).toBe("andreas/research/luna");
  });
});

describe("collectLegendStacks (#1068)", () => {
  it("returns no rows for an empty graph", () => {
    expect(collectLegendStacks({ nodes: [], edges: [] })).toEqual([]);
  });

  it("one row per stack-hub, local first, with label + matching hub color", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }), // local self
      siblingTile({ agent_id: "echo", stack: "work" }), // andreas/work
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const rows = collectLegendStacks(g);
    expect(rows).toHaveLength(3);

    // Local first; its label is "local" and its color the reserved signature.
    expect(rows[0]!.id).toBe(STACK_HUB_NODE_ID);
    expect(rows[0]!.label).toBe("local");
    expect(rows[0]!.color).toBe(LOCAL_STACK_COLOR);

    // Peers carry their `{principal}/{stack}` label + their hub's color.
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("andreas/work");
    expect(labels).toContain("jc/research");

    // Each legend color equals its hub node's stackColor (one source of truth).
    for (const row of rows) {
      const hub = g.nodes.find((n) => n.id === row.id)!.data as StackHubNodeData;
      expect(row.color).toBe(hub.stackColor);
    }
    // The three colors are distinct.
    expect(new Set(rows.map((r) => r.color)).size).toBe(3);
  });
});

describe("buildNetworkGraph — federated edge flag (MC-D3 #1290)", () => {
  it("flags a CROSS-PRINCIPAL foreign peer's hub→agent edges federated=true", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const foreignEdge = g.edges.find((e) => e.target === "jc/research/sage");
    expect(foreignEdge?.data?.federated).toBe(true);
  });

  it("leaves a LOCAL stack's hub→agent edges federated=false (solid)", () => {
    const g = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const localEdge = g.edges.find((e) => e.target === "andreas/research/luna");
    expect(localEdge?.data?.federated).toBe(false);
  });

  it("leaves a SAME-PRINCIPAL sibling's edges federated=false (local, not federation)", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      siblingTile({ agent_id: "echo", stack: "work" }),
    ]);
    const siblingEdge = g.edges.find((e) => e.target === "andreas/work/echo");
    expect(siblingEdge?.data?.federated).toBe(false);
  });

  it("the edge flag agrees with the node classifier for the same origin", () => {
    const g = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const foreignEdge = g.edges.find((e) => e.target === "jc/research/sage");
    // The classifier says foreign for jc (a cross-principal peer vs serving andreas).
    expect(classifyOrigin({ principal: "jc", stack: "research" }, "andreas")).toBe(
      "foreign",
    );
    expect(foreignEdge?.data?.federated).toBe(true);
  });
});

/**
 * MC-D4 — a minimal `NetworkMembershipDTO` fixture. Only the fields the adapter
 * reads (`network_id`, `members[].{principal,verdict,present_stacks}`) matter;
 * the rest are filled with honest defaults.
 */
function membership(
  over: Partial<NetworkMembershipDTO> & {
    network_id: string;
    members: NetworkMembershipDTO["members"];
  },
): NetworkMembershipDTO {
  return {
    leaf_node: "leaf-1",
    roster_status: "ok",
    roster_scope: "complete",
    confidentiality: { mode: "off", key_present: false, key_id: null },
    ...over,
  };
}

/** One roster member DTO. */
function member(
  principal: string,
  present_stacks: string[],
  verdict: NetworkMembershipDTO["members"][number]["verdict"] = present_stacks.length
    ? "admitted-present"
    : "absent-offline",
): NetworkMembershipDTO["members"][number] {
  return { principal, verdict, present_stacks, accepts: "accepted-network" };
}

describe("buildNetworkGraph — absent federated peers (MC-D4)", () => {
  it("emits a dimmed federated-peer node + a dotted anchor edge for an absent non-local member", () => {
    const g = buildNetworkGraph(
      [tile({ agent_id: "luna" })], // one present LOCAL agent (⇒ a local hub exists)
      [
        membership({
          network_id: "mfnet",
          members: [
            member("andreas", ["research"]), // the serving principal — present
            member("jc", []), // admitted but ABSENT (no present stacks)
          ],
        }),
      ],
    );

    const peerId = federatedPeerIdForPrincipal("jc");
    expect(peerId.startsWith(FEDERATED_PEER_ID_PREFIX)).toBe(true);

    const peerNode = g.nodes.find((n) => n.id === peerId);
    expect(peerNode).toBeDefined();
    expect(peerNode?.type).toBe("federatedPeer");
    const data = peerNode?.data as FederatedPeerNodeData;
    expect(data.kind).toBe("federated-peer");
    expect(data.principal).toBe("jc");
    expect(data.networkId).toBe("mfnet");
    expect(data.verdict).toBe("absent-offline");

    // The dotted anchor edge: local hub → the peer placeholder, flagged absent.
    const edge = g.edges.find((e) => e.target === peerId);
    expect(edge).toBeDefined();
    expect(edge?.source).toBe(STACK_HUB_NODE_ID);
    expect(edge?.data?.federatedAbsent).toBe(true);
    // It is NOT the present-peer `federated` (dashed) edge treatment.
    expect(edge?.data?.federated ?? false).toBe(false);
  });

  it("produces nothing extra when an absent member has NO roster (networks omitted)", () => {
    const withRoster = buildNetworkGraph([tile({ agent_id: "luna" })], []);
    const withoutRoster = buildNetworkGraph([tile({ agent_id: "luna" })]);
    // Byte-identical: no roster ⇒ no absent-peer nodes/edges (pre-D4 shape).
    expect(withRoster).toEqual(withoutRoster);
    expect(
      withRoster.nodes.some((n) => n.type === "federatedPeer"),
    ).toBe(false);
    expect(
      withRoster.edges.some((e) => e.data?.federatedAbsent === true),
    ).toBe(false);
  });

  it("does NOT emit a placeholder for the serving (local) principal", () => {
    const g = buildNetworkGraph(
      [tile({ agent_id: "luna" })],
      [membership({ network_id: "mfnet", members: [member("andreas", [])] })],
    );
    expect(g.nodes.some((n) => n.type === "federatedPeer")).toBe(false);
  });

  it("does NOT emit a placeholder for a PRESENT foreign peer (already a stack hub — E.3 folding preserved)", () => {
    const g = buildNetworkGraph(
      [
        tile({ agent_id: "luna" }),
        foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
      ],
      [
        membership({
          network_id: "mfnet",
          members: [member("andreas", ["research"]), member("jc", ["research"])],
        }),
      ],
    );
    // jc is present (has an agent tile ⇒ its own stack hub); no absent placeholder.
    expect(g.nodes.some((n) => n.type === "federatedPeer")).toBe(false);
    // The present foreign peer still renders as its stack hub (E.3 unchanged).
    expect(
      g.nodes.some(
        (n) =>
          n.type === "stackHub" &&
          n.id === `${FOREIGN_HUB_ID_PREFIX}jc/research`,
      ),
    ).toBe(true);
  });

  it("de-duplicates an absent peer that appears on multiple networks (first-seen wins)", () => {
    const g = buildNetworkGraph(
      [tile({ agent_id: "luna" })],
      [
        membership({ network_id: "net-a", members: [member("jc", [])] }),
        membership({ network_id: "net-b", members: [member("jc", [])] }),
      ],
    );
    const peers = g.nodes.filter((n) => n.type === "federatedPeer");
    expect(peers).toHaveLength(1);
    expect((peers[0]?.data as FederatedPeerNodeData).networkId).toBe("net-a");
  });

  it("emits no placeholder when there is no LOCAL hub to anchor to (foreign-only snapshot)", () => {
    // A snapshot of ONLY a foreign agent ⇒ no local `__stack__` hub. An absent
    // peer would have nothing to anchor to, so none is emitted.
    const g = buildNetworkGraph(
      [foreignTile({ agent_id: "sage", principal: "jc", stack: "research" })],
      [membership({ network_id: "mfnet", members: [member("kim", [])] })],
    );
    expect(g.nodes.some((n) => n.type === "federatedPeer")).toBe(false);
  });
});
