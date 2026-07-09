/**
 * MC-D1 (netui-constellation) — radial constellation layout tests.
 *
 * The old ELK layout was async + WASM-backed, so it was tested against a
 * deterministic stub. The constellation layout is a PURE, SYNCHRONOUS function of
 * the graph data, so we can assert exact positions directly: clustering (agents
 * bucketed under their hub), ring geometry (agents evenly distributed around the
 * hub centre at the count-scaled radius), cluster-grid placement, and the
 * 2-point centre-to-centre edge routes.
 */

import { describe, it, expect } from "bun:test";
import {
  layoutNetworkGraph,
  clusterNetworkGraph,
  clusterCentre,
  ringRadiusForCount,
  RADIAL_LAYOUT,
  HUB_NODE_SIZE,
  AGENT_NODE_SIZE,
} from "../lib/network-graph-layout";
import {
  buildNetworkGraph,
  STACK_HUB_NODE_ID,
  federatedPeerIdForPrincipal,
} from "../lib/network-graph-adapter";
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

/**
 * MC-D4 — a minimal `NetworkMembershipDTO` fixture (only the fields the adapter
 * reads matter). Mirrors the network-graph-adapter test helper so the layout
 * test can build a graph that carries an absent-federated-peer node.
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

/** One roster member DTO (absent when it has no present stacks). */
function member(
  principal: string,
  present_stacks: string[] = [],
): NetworkMembershipDTO["members"][number] {
  return {
    principal,
    verdict: present_stacks.length ? "admitted-present" : "absent-offline",
    present_stacks,
    accepts: "accepted-network",
  };
}

describe("ringRadiusForCount (MC-D1)", () => {
  it("returns the base radius for a single-agent cluster", () => {
    expect(ringRadiusForCount(1)).toBe(RADIAL_LAYOUT.baseRingRadius);
  });

  it("grows the radius with the agent count", () => {
    expect(ringRadiusForCount(3)).toBe(
      RADIAL_LAYOUT.baseRingRadius + 2 * RADIAL_LAYOUT.radiusPerAgent,
    );
  });

  it("clamps to the max radius for a very dense cluster", () => {
    expect(ringRadiusForCount(1000)).toBe(RADIAL_LAYOUT.maxRingRadius);
  });
});

describe("clusterCentre (MC-D1)", () => {
  it("centres a single cluster on the origin", () => {
    expect(clusterCentre(0, 1)).toEqual({ x: 0, y: 0 });
  });

  it("spreads two clusters symmetrically about the origin, one stride apart", () => {
    const a = clusterCentre(0, 2);
    const b = clusterCentre(1, 2);
    expect(b.x - a.x).toBe(RADIAL_LAYOUT.clusterStride);
    // Symmetric about x=0.
    expect(a.x).toBe(-RADIAL_LAYOUT.clusterStride / 2);
    expect(b.x).toBe(RADIAL_LAYOUT.clusterStride / 2);
  });

  it("lays four clusters out on a 2×2 grid", () => {
    // cols = ceil(sqrt(4)) = 2 → indices 0,1 on row 0; 2,3 on row 1.
    const c0 = clusterCentre(0, 4);
    const c3 = clusterCentre(3, 4);
    expect(c3.x - c0.x).toBe(RADIAL_LAYOUT.clusterStride);
    expect(c3.y - c0.y).toBe(RADIAL_LAYOUT.clusterStride);
  });
});

describe("clusterNetworkGraph (MC-D1)", () => {
  it("buckets each agent under its hub", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const clusters = clusterNetworkGraph(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.hubId).toBe(STACK_HUB_NODE_ID);
    expect(clusters[0]!.agentIds).toHaveLength(2);
  });

  it("emits one cluster per stack, local hub first", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const clusters = clusterNetworkGraph(graph);
    expect(clusters).toHaveLength(2);
    // Local hub cluster is first (the adapter emits the local hub first).
    expect(clusters[0]!.hubId).toBe(STACK_HUB_NODE_ID);
    expect(clusters[0]!.agentIds).toHaveLength(1);
    expect(clusters[1]!.hubId).toBe("__stack__:jc/research");
    expect(clusters[1]!.agentIds).toHaveLength(1);
  });

  it("gives an ABSENT federated-peer node its OWN singleton cluster (not the local hub ring)", () => {
    // MC-D4 vis2: an admitted-but-absent peer must NOT be bucketed onto the
    // local hub's agent ring (where it drowns among the local agents). It gets
    // its own singleton cluster so it lands on a distinct cluster-grid cell.
    const graph = buildNetworkGraph(
      [tile({ agent_id: "luna" }), tile({ agent_id: "echo" })],
      [
        membership({
          network_id: "mfnet",
          members: [member("andreas", ["research"]), member("jc")],
        }),
      ],
    );
    const peerId = federatedPeerIdForPrincipal("jc");
    const clusters = clusterNetworkGraph(graph);

    // The local hub keeps ONLY its two local agents — the peer is not in its ring.
    const localCluster = clusters.find((c) => c.hubId === STACK_HUB_NODE_ID)!;
    expect(localCluster.agentIds).not.toContain(peerId);
    expect(localCluster.agentIds).toHaveLength(2);

    // The peer forms its own hub-less singleton cluster (hubId === the peer id).
    const peerCluster = clusters.find((c) => c.hubId === peerId);
    expect(peerCluster).toBeDefined();
    expect(peerCluster!.agentIds).toHaveLength(0);
  });
});

describe("layoutNetworkGraph (MC-D1)", () => {
  it("short-circuits on an empty graph", () => {
    expect(layoutNetworkGraph({ nodes: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it("places the hub at the cluster centre and rings its agents around it", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
      tile({ agent_id: "sage" }),
    ]);
    const { nodes } = layoutNetworkGraph(graph);
    // 1 hub + 3 agents.
    expect(nodes).toHaveLength(4);

    const hub = nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    // Single cluster → centred on the origin.
    expect(hub.position).toEqual({ x: 0, y: 0 });

    const agents = nodes.filter((n) => n.type === "agent");
    const radius = ringRadiusForCount(3);
    for (const a of agents) {
      // Every agent sits on the ring: distance from the hub centre == radius.
      const dist = Math.hypot(a.position.x - 0, a.position.y - 0);
      expect(dist).toBeCloseTo(radius, 6);
    }
    // The first agent sits at the deterministic start angle (straight up: the
    // ring's -90° spoke, so x≈0, y≈-radius).
    const first = agents[0]!;
    expect(first.position.x).toBeCloseTo(0, 6);
    expect(first.position.y).toBeCloseTo(-radius, 6);
  });

  it("distributes agents evenly by angle (no two agents overlap)", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "a" }),
      tile({ agent_id: "b" }),
      tile({ agent_id: "c" }),
      tile({ agent_id: "d" }),
    ]);
    const { nodes } = layoutNetworkGraph(graph);
    const agents = nodes.filter((n) => n.type === "agent");
    const seen = new Set(agents.map((a) => `${a.position.x.toFixed(3)},${a.position.y.toFixed(3)}`));
    // Four distinct positions on the ring.
    expect(seen.size).toBe(4);
  });

  it("separates multiple stacks into their own cluster centres", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      foreignTile({ agent_id: "sage", principal: "jc", stack: "research" }),
    ]);
    const { nodes } = layoutNetworkGraph(graph);
    const localHub = nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    const foreignHub = nodes.find((n) => n.id === "__stack__:jc/research")!;
    // Two clusters, one stride apart on the x axis.
    expect(Math.abs(foreignHub.position.x - localHub.position.x)).toBe(
      RADIAL_LAYOUT.clusterStride,
    );
  });

  it("places an ABSENT federated peer at its OWN cluster cell, NOT on the local hub ring", () => {
    // MC-D4 vis2: the peer node must land at a distinct position — neither the
    // local cluster centre nor anywhere on the local hub's agent ring — so it
    // reads as a separate federated presence, not a faint dot among local agents.
    const graph = buildNetworkGraph(
      [tile({ agent_id: "luna" }), tile({ agent_id: "echo" })],
      [
        membership({
          network_id: "mfnet",
          members: [member("andreas", ["research"]), member("jc")],
        }),
      ],
    );
    const peerId = federatedPeerIdForPrincipal("jc");
    const { nodes } = layoutNetworkGraph(graph);

    const localHub = nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    const peer = nodes.find((n) => n.id === peerId)!;
    expect(peer.type).toBe("federatedPeer");

    // Not co-located with the local hub centre.
    expect(peer.position).not.toEqual(localHub.position);

    // A distinct cluster (2 clusters: local + peer singleton) → a full stride
    // away from the local hub, NOT on its (much smaller) agent ring radius.
    const distFromLocalHub = Math.hypot(
      peer.position.x - localHub.position.x,
      peer.position.y - localHub.position.y,
    );
    expect(distFromLocalHub).toBe(RADIAL_LAYOUT.clusterStride);
    // Sanity: a cluster stride is well beyond any local agent ring radius.
    expect(distFromLocalHub).toBeGreaterThan(ringRadiusForCount(2));

    // No LOCAL agent sits at the peer's position (it's off the local ring).
    const localAgents = nodes.filter(
      (n) => n.type === "agent" && n.id.startsWith("andreas/"),
    );
    for (const a of localAgents) {
      expect(a.position).not.toEqual(peer.position);
    }
  });

  it("still routes the dotted fed-absent edge local-hub → peer across the clusters", () => {
    const graph = buildNetworkGraph(
      [tile({ agent_id: "luna" })],
      [
        membership({
          network_id: "mfnet",
          members: [member("andreas", ["research"]), member("jc")],
        }),
      ],
    );
    const peerId = federatedPeerIdForPrincipal("jc");
    const { nodes, edges } = layoutNetworkGraph(graph);
    const fedEdge = edges.find((e) => e.target === peerId)!;
    expect(fedEdge.source).toBe(STACK_HUB_NODE_ID);
    expect(fedEdge.data?.federatedAbsent).toBe(true);
    // The route is the long cross-cluster spoke (local hub centre → peer centre).
    const localHub = nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    const peer = nodes.find((n) => n.id === peerId)!;
    const pts = fedEdge.layout.elkPoints!;
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ x: localHub.position.x, y: localHub.position.y });
    expect(pts[1]).toEqual({ x: peer.position.x, y: peer.position.y });
  });

  it("preserves node data + type, only replacing position", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna", assistant_name: "Luna" }),
    ]);
    const { nodes } = layoutNetworkGraph(graph);
    const agent = nodes.find((n) => n.type === "agent")!;
    expect(agent.data).toEqual(
      graph.nodes.find((n) => n.type === "agent")!.data,
    );
  });

  it("routes each edge as a 2-point hub-centre → agent-centre spoke", () => {
    const graph = buildNetworkGraph([
      tile({ agent_id: "luna" }),
      tile({ agent_id: "echo" }),
    ]);
    const { nodes, edges } = layoutNetworkGraph(graph);
    expect(edges).toHaveLength(2);
    const hub = nodes.find((n) => n.id === STACK_HUB_NODE_ID)!;
    for (const e of edges) {
      const pts = e.layout.elkPoints!;
      expect(pts).toHaveLength(2);
      // First point is the hub centre.
      expect(pts[0]).toEqual({ x: hub.position.x, y: hub.position.y });
      // Second point is the target agent's centre.
      const agent = nodes.find((n) => n.id === e.target)!;
      expect(pts[1]).toEqual({ x: agent.position.x, y: agent.position.y });
      // Face geometry is populated for the edge's dragged-node fallback.
      expect(typeof e.layout.layoutSourceX).toBe("number");
      expect(typeof e.layout.targetBottomY).toBe("number");
    }
  });

  it("preserves the edge id/source/target through layout", () => {
    const graph = buildNetworkGraph([tile({ agent_id: "luna" })]);
    const { edges } = layoutNetworkGraph(graph);
    expect(edges[0]!.id).toBe(graph.edges[0]!.id);
    expect(edges[0]!.source).toBe(graph.edges[0]!.source);
    expect(edges[0]!.target).toBe(graph.edges[0]!.target);
  });

  it("exposes the circle-node footprints (hub larger than agent)", () => {
    expect(HUB_NODE_SIZE.width).toBeGreaterThan(AGENT_NODE_SIZE.width);
  });
});
