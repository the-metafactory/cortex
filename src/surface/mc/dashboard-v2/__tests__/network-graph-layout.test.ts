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

  it("uses the layered algorithm + orthogonal routing with component separation (#1008)", () => {
    // #1008: cortex's topology is a SET of hub→agents trees. `layered` (DOWN)
    // places each hub above its agents (tidy per-stack tree), ORTHOGONAL routing
    // gives right-angled bend points (rendered as rounded polylines, no diagonal
    // crossings), and separateConnectedComponents packs each stack-tree apart.
    expect(NETWORK_ELK_OPTIONS["elk.algorithm"]).toContain("layered");
    expect(NETWORK_ELK_OPTIONS["elk.direction"]).toBe("DOWN");
    expect(NETWORK_ELK_OPTIONS["elk.edgeRouting"]).toBe("ORTHOGONAL");
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

/**
 * Deterministic ELK stub: lays nodes out on a fixed grid, no WASM, and emits a
 * simple orthogonal `sections[0]` per edge (start → one bend → end) so the
 * edge-route extraction has something to read back.
 */
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
        edges: graph.edges.map((e) => ({
          id: e.id,
          sections: [
            {
              startPoint: { x: 0, y: 0 },
              bendPoints: [{ x: 0, y: 25 }],
              endPoint: { x: 0, y: 50 },
            },
          ],
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
    expect(out).toEqual({ nodes: [], edges: [] });
    expect(called).toBe(false);
  });

  it("applies ELK-returned positions to the nodes", async () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const { nodes } = await layoutNetworkGraph(stubElk(), graph);
    // 1 hub + 2 agents
    expect(nodes).toHaveLength(3);
    // The hub is index 0 in the adapter output → stub put it at (0,0).
    const hub = nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    expect(hub.position).toEqual({ x: 0, y: 0 });
    // The 2nd node got (100,50) from the stub.
    expect(nodes[1]!.position).toEqual({ x: 100, y: 50 });
    expect(nodes[2]!.position).toEqual({ x: 200, y: 100 });
  });

  it("extracts ELK's edge bend points into each edge's layout payload (#1008)", async () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const { edges } = await layoutNetworkGraph(stubElk(), graph);
    expect(edges).toHaveLength(2);
    for (const e of edges) {
      // [startPoint, ...bendPoints, endPoint] — the stub emits 3 points.
      expect(e.layout.elkPoints).toEqual([
        { x: 0, y: 0 },
        { x: 0, y: 25 },
        { x: 0, y: 50 },
      ]);
      // Source/target face geometry is populated (for face-clamping).
      expect(typeof e.layout.layoutSourceX).toBe("number");
      expect(typeof e.layout.targetBottomY).toBe("number");
    }
  });

  it("preserves the origin-grouped edge id/source/target through layout (#1008)", async () => {
    const graph = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const { edges } = await layoutNetworkGraph(stubElk(), graph);
    expect(edges[0]!.id).toBe(graph.edges[0]!.id);
    expect(edges[0]!.source).toBe(graph.edges[0]!.source);
    expect(edges[0]!.target).toBe(graph.edges[0]!.target);
  });

  it("preserves node data while only replacing position", async () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna", assistant_name: "Luna" }),
    ]);
    const { nodes } = await layoutNetworkGraph(stubElk(), graph);
    const agent = nodes.find((n) => n.type === "agent")!;
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
    const { nodes, edges } = await layoutNetworkGraph(partial, graph);
    for (const n of nodes) expect(n.position).toEqual({ x: 0, y: 0 });
    // An edge ELK didn't route carries no elkPoints (the edge falls back).
    expect(edges[0]!.layout.elkPoints).toBeUndefined();
  });
});
