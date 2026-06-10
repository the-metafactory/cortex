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
        "state",
      ].sort(),
    );
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
