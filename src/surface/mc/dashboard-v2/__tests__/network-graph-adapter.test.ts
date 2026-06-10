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
  STACK_HUB_NODE_ID,
  FOREIGN_HUB_ID_PREFIX,
  type AgentNodeData,
  type StackHubNodeData,
} from "../lib/network-graph-adapter";
import type { AgentPresenceTile } from "../hooks/use-agents";

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
    // is a fixed allowlist — assert the key set is exactly the presence fields.
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
        "state",
      ].sort(),
    );
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
