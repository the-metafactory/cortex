/**
 * G-1114.D.3 — ELK layout tests.
 *
 * The real ELK engine is WASM-backed + async and non-trivial to assert
 * positions on, so we test the pure translation (`toElkGraph`) exactly and the
 * async `layoutNetworkGraph` against a deterministic ELK STUB — verifying the
 * orchestration (short-circuit on empty, apply returned positions, defensive
 * fallback for an unpositioned node) without depending on ELK's exact geometry.
 * A separate smoke test in network-view.test exercises the real elk import path.
 */

import { describe, it, expect } from "bun:test";
import {
  toElkGraph,
  layoutNetworkGraph,
  NETWORK_ELK_OPTIONS,
  HUB_NODE_SIZE,
  AGENT_NODE_SIZE,
  type ElkLike,
  type ElkInputGraph,
  type ElkLaidOutGraph,
} from "../lib/network-graph-layout";
import { buildNetworkGraph, STACK_HUB_NODE_ID } from "../lib/network-graph-adapter";
import type { AgentPresenceTile } from "../hooks/use-agents";

function tile(
  over: Partial<AgentPresenceTile> & { agent_id: string },
): AgentPresenceTile {
  const { agent_id } = over;
  return {
    key: `andreas/research/${agent_id}`,
    origin: "local",
    assistant_name: null,
    nkey_public_key: `N${agent_id}`,
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

/** A FOREIGN tile under a peer's verified {principal}/{stack}. */
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

describe("toElkGraph (G-1114.D.3)", () => {
  it("maps nodes to ELK children with the right footprints", () => {
    const graph = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const elk = toElkGraph(graph);
    expect(elk.id).toBe("root");
    expect(elk.layoutOptions).toEqual(NETWORK_ELK_OPTIONS);

    const hub = elk.children.find((c) => c.id === STACK_HUB_NODE_ID)!;
    expect(hub.width).toBe(HUB_NODE_SIZE.width);
    expect(hub.height).toBe(HUB_NODE_SIZE.height);

    const agent = elk.children.find((c) => c.id !== STACK_HUB_NODE_ID)!;
    expect(agent.width).toBe(AGENT_NODE_SIZE.width);
    expect(agent.height).toBe(AGENT_NODE_SIZE.height);
  });

  it("maps each edge to an ELK source/target pair", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const elk = toElkGraph(graph);
    expect(elk.edges).toHaveLength(2);
    for (const e of elk.edges) {
      expect(e.sources).toEqual([STACK_HUB_NODE_ID]);
      expect(e.targets).toHaveLength(1);
    }
  });

  it("uses the force algorithm with component separation (multi-cluster stars)", () => {
    // E.3: several disconnected stack-clusters (local + each peer) — force +
    // separateConnectedComponents lays each out as its own group rather than
    // forcing a single radial root.
    expect(NETWORK_ELK_OPTIONS["elk.algorithm"]).toContain("force");
    expect(NETWORK_ELK_OPTIONS["elk.separateConnectedComponents"]).toBe("true");
  });

  it("maps a multi-stack graph into ELK children + per-cluster edges (E.3)", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const elk = toElkGraph(graph);
    // 2 hubs (local + jc/research) + 2 agents = 4 children
    expect(elk.children).toHaveLength(4);
    // 2 edges, each sourced from its own cluster's hub (disconnected components)
    expect(elk.edges).toHaveLength(2);
    const sources = elk.edges.flatMap((e) => e.sources).sort();
    expect(sources).toContain(STACK_HUB_NODE_ID);
    expect(sources).toContain("__stack__:jc/research");
  });
});

/** Deterministic ELK stub: lays nodes out on a fixed grid, no WASM. */
function stubElk(): ElkLike {
  return {
    async layout(graph: ElkInputGraph): Promise<ElkLaidOutGraph> {
      return {
        children: graph.children.map((c, i) => ({
          id: c.id,
          x: i * 100,
          y: i * 50,
          width: c.width,
          height: c.height,
        })),
      };
    },
  };
}

describe("layoutNetworkGraph (G-1114.D.3)", () => {
  it("short-circuits on an empty graph without calling ELK", async () => {
    let called = false;
    const spy: ElkLike = {
      async layout() {
        called = true;
        return {};
      },
    };
    const out = await layoutNetworkGraph(spy, { nodes: [], edges: [] });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("applies ELK-returned positions to the nodes", async () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const out = await layoutNetworkGraph(stubElk(), graph);
    // 1 hub + 2 agents
    expect(out).toHaveLength(3);
    // The hub is index 0 in the adapter output → stub put it at (0,0).
    const hub = out.find((n) => n.id === STACK_HUB_NODE_ID)!;
    expect(hub.position).toEqual({ x: 0, y: 0 });
    // The 2nd node got (100,50) from the stub.
    expect(out[1]!.position).toEqual({ x: 100, y: 50 });
    expect(out[2]!.position).toEqual({ x: 200, y: 100 });
  });

  it("preserves node data while only replacing position", async () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna", assistant_name: "Luna" }),
    ]);
    const out = await layoutNetworkGraph(stubElk(), graph);
    const agent = out.find((n) => n.type === "agent")!;
    expect(agent.data).toEqual(
      graph.nodes.find((n) => n.type === "agent")!.data,
    );
  });

  it("falls back to the incoming position for a node ELK omitted", async () => {
    const graph = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const partial: ElkLike = {
      async layout() {
        // Return positions for nothing — every node should keep its {0,0}.
        return { children: [] };
      },
    };
    const out = await layoutNetworkGraph(partial, graph);
    for (const n of out) expect(n.position).toEqual({ x: 0, y: 0 });
  });
});
